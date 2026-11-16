/**
 * Hands the chains this adapter declares for Ruby's environment and
 * output streams every site a body reads or writes at, and places what
 * they report at the site, in source order. Which sites a body owns is
 * this adapter's walk: a method or a lambda waits for its own unit, and a
 * block a pack claims is a unit of its own. A parameter default runs at
 * the call that leaves the argument out, so a call also reports the reads
 * in the defaults it runs, which the chain reads at the default and the
 * call takes on. A write in a method's own default stays the method's.
 */

import {
  locatedBeforeGroupId,
  numberRepeatedCallSites,
  SKIP_CHILDREN,
  walkDescendants,
} from "@suss/extractor";
import { factCallOps, factReadOps } from "@suss/recognize/ops";

import { children, field, rangeOf } from "../ast.js";
import { isClaimed } from "../claims.js";
import {
  calleesOfCalls,
  defaultReadsAtCall,
  hasDefaultReads,
  isOwnParameter,
} from "../envReads.js";
import { factSourceOf } from "../factSource.js";
import { resolveValues } from "../facts/resolve.js";
import { nodeOfResolutionKey, resolutionKeyOf } from "../values/evaluator.js";
import { environmentReads } from "./environment.js";
import { KERNEL_WRITE_NAMES, streamWriteHooks } from "./streams.js";

import type { Effect } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type { CallOps, FactSource, ReadOps } from "@suss/extractor";
import type { NodeMap } from "../ast.js";
import type { DefaultReadAtCall } from "../envReads.js";
import type { RbNode } from "../parser.js";
import type { EffectAt } from "../paths/effects.js";

/** A method or lambda body runs when it is called, so its reads wait for its own unit. */
const DEFERRED_BODY_TYPES = new Set(["method", "singleton_method", "lambda"]);

/** The nodes a read can be at: a key and a call. */
const SITE_TYPES = new Set(["element_reference", "call"]);

/** `out << line`, which Ruby runs as the method `<<` on `out` and the facts state as that call. */
function isAppend(node: RbNode): boolean {
  return node.type === "binary" && field(node, "operator")?.text === "<<";
}

/** A node the facts state as a call. */
function isCall(node: RbNode): boolean {
  return node.type === "call" || isAppend(node);
}

/** The ops a chain asks of one site. */
interface SiteContext {
  readonly read: ReadOps;
  readonly ops: CallOps | null;
}

/** A site the walk visited, with its ops, or null for a node the facts give no key. */
interface Site {
  readonly node: RbNode;
  readonly context: SiteContext | null;
  /** Whether the site is in a default of the root's own parameters. */
  readonly inOwnDefault: boolean;
}

/**
 * The environment reads under `root`, in source order, each at the node
 * it was read at. `root` itself is not read: pass a method for its body,
 * or the program node for what runs when the file loads. The blocks and
 * lambdas in `claimed` are units of their own and are left out.
 */
export function stdlibReads(
  root: RbNode,
  db: Database,
  claimed?: ReadonlySet<number>,
): EffectAt[] {
  return readsAt(sitesUnder(root, db, claimed), db);
}

/**
 * The environment reads and the stream writes under `root`, from one
 * walk, each at the node it was made at. A unit places the two apart,
 * in the slots its body's effects go in.
 */
export function stdlibEffects(
  root: RbNode,
  db: Database,
  claimed?: ReadonlySet<number>,
): { reads: EffectAt[]; writes: EffectAt[] } {
  const sites = sitesUnder(root, db, claimed);
  return { reads: readsAt(sites, db), writes: writesAt(sites, db) };
}

function readsAt(all: readonly Site[], db: Database): EffectAt[] {
  const sites = all.filter(
    (site) => !site.inOwnDefault && !isAppend(site.node),
  );
  const defaults = hasDefaultReads(db);
  const callees = calleesOfCalls(
    db,
    sites.flatMap(({ node }) => (node.type === "call" ? [node] : [])),
    defaults,
  );
  return sites.flatMap(({ node, context }) => {
    const effects = [
      ...((context === null ? null : environmentReads(node, context)) ?? []),
      ...(defaults ? defaultReadsAt(node, callees, db) : []),
    ];
    return effects.map((effect) => ({
      effect: { ...effect, location: rangeOf(node) },
      at: node,
    }));
  });
}

/** The writes, one list per call, with a write repeated in the body numbered. */
function writesAt(sites: readonly Site[], db: Database): EffectAt[] {
  const calls = sites.filter(
    (site): site is Site & { context: SiteContext } =>
      isCall(site.node) && site.context !== null,
  );
  askWhatBareWritesRun(calls, db);
  return numberRepeatedCallSites(
    calls.map(({ node, context }) =>
      streamWriteHooks
        .flatMap((hook) => hook(node, context) ?? [])
        .map((effect) => ({
          effect: locatedBeforeGroupId(effect, rangeOf(node)),
          at: node,
        })),
    ),
  ).flat();
}

/**
 * Asks in one round which method each call with no receiver and the name
 * of one of Kernel's writes runs, since a class can define its own
 * `warn`, and such a call then writes nothing.
 */
function askWhatBareWritesRun(calls: readonly Site[], db: Database): void {
  const callees = calls.flatMap(({ node }) => {
    const method = field(node, "method")?.text ?? "";
    const key =
      field(node, "receiver") === null && KERNEL_WRITE_NAMES.includes(method)
        ? resolutionKeyOf(node)
        : null;
    return key === null
      ? []
      : db.lookup("call", 0, key).map((row) => String(row[1]));
  });
  if (callees.length > 0) {
    resolveValues(db, callees);
  }
}

function sitesUnder(
  root: RbNode,
  db: Database,
  claimed: ReadonlySet<number> | undefined,
): Site[] {
  const source = factSourceOf(db);
  const sites: Site[] = [];
  walkDescendants<RbNode, boolean>(root, false, children, {
    at: (node, inOwnDefault) => {
      if (!SITE_TYPES.has(node.type) && !isAppend(node)) {
        return;
      }
      const key = resolutionKeyOf(node);
      sites.push({
        node,
        context: key === null ? null : siteContext(key, node, source),
        inOwnDefault,
      });
    },
    into: (node, inOwnDefault) =>
      DEFERRED_BODY_TYPES.has(node.type) || isClaimed(node, claimed)
        ? SKIP_CHILDREN
        : inOwnDefault || isOwnParameter(node, root),
  });
  return sites;
}

/**
 * The reads in the defaults a call runs, one per variable. Each is what
 * the chain reads at the variable's first default, defaulted only when
 * every default that reads it copes with a missing value.
 */
function defaultReadsAt(
  call: RbNode,
  callees: NodeMap<string[]>,
  db: Database,
): Effect[] {
  const keys = callees.get(call);
  if (keys === undefined) {
    return [];
  }
  const source = factSourceOf(db);
  return defaultReadsAtCall(db, call, keys).flatMap((read) => {
    const site = nodeOfResolutionKey(read.site, db);
    const [effect] =
      site === null
        ? []
        : (environmentReads(site, siteContext(read.site, site, source)) ?? []);
    return effect === undefined ? [] : [readAtCall(effect, read)];
  });
}

/** The read at a default, as the call that runs it reports it. */
function readAtCall(effect: Effect, read: DefaultReadAtCall): Effect {
  if (
    effect.type !== "interaction" ||
    effect.interaction.class !== "config-read"
  ) {
    return effect;
  }
  const { default: fallback, ...interaction } = effect.interaction;
  return {
    ...effect,
    interaction: {
      ...interaction,
      defaulted: read.defaulted,
      ...(read.defaulted && fallback !== undefined
        ? { default: fallback }
        : {}),
    },
  };
}

/** The ops a chain asks of one site, each built the first time it is asked for. */
function siteContext(
  key: string,
  node: RbNode,
  source: FactSource,
): SiteContext {
  let read: ReadOps | undefined;
  let ops: CallOps | null | undefined;
  return {
    get read() {
      read ??= factReadOps(key, source);
      return read;
    },
    get ops() {
      if (ops === undefined) {
        ops = isCall(node) ? factCallOps(key, source) : null;
      }
      return ops;
    },
  };
}
