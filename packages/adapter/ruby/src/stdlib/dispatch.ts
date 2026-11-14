/**
 * Hands the read chain this adapter declares for Ruby's environment every
 * site a body reads at, and places what it reports at the site, in
 * source order. Which sites a body owns is this adapter's walk: a method
 * or a lambda waits for its own unit, a block a pack claims is a unit of
 * its own, and a parameter default runs at the call that leaves the
 * argument out. So a call also reports the reads in the defaults it runs,
 * which the chain reads at the default and the call takes on.
 */

import { SKIP_CHILDREN, walkDescendants } from "@suss/extractor";
import { factCallOps, factReadOps } from "@suss/recognize/ops";

import { children, rangeOf } from "../ast.js";
import { isClaimed } from "../claims.js";
import {
  calleesOfCalls,
  defaultReadsAtCall,
  hasDefaultReads,
  isOwnParameter,
} from "../envReads.js";
import { factSourceOf } from "../factSource.js";
import { nodeOfResolutionKey, resolutionKeyOf } from "../values/evaluator.js";
import { environmentReads } from "./environment.js";

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
  const sites = sitesUnder(root, claimed);
  const defaults = hasDefaultReads(db);
  const callees = calleesOfCalls(
    db,
    sites.filter((node) => node.type === "call"),
    defaults,
  );
  const source = factSourceOf(db);
  return sites.flatMap((node) => {
    const key = resolutionKeyOf(node);
    const own =
      key === null
        ? null
        : environmentReads(node, siteContext(key, node, source));
    const effects = [
      ...(own ?? []),
      ...(defaults ? defaultReadsAt(node, callees, db) : []),
    ];
    return effects.map((effect) => ({
      effect: { ...effect, location: rangeOf(node) },
      at: node,
    }));
  });
}

function sitesUnder(
  root: RbNode,
  claimed: ReadonlySet<number> | undefined,
): RbNode[] {
  const sites: RbNode[] = [];
  walkDescendants<RbNode, null>(root, null, children, {
    at: (node) => {
      if (SITE_TYPES.has(node.type)) {
        sites.push(node);
      }
    },
    into: (node) =>
      DEFERRED_BODY_TYPES.has(node.type) ||
      isOwnParameter(node, root) ||
      isClaimed(node, claimed)
        ? SKIP_CHILDREN
        : null,
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
): { read: ReadOps; ops: CallOps | null } {
  let read: ReadOps | undefined;
  let ops: CallOps | null | undefined;
  return {
    get read() {
      read ??= factReadOps(key, source);
      return read;
    },
    get ops() {
      if (ops === undefined) {
        ops = node.type === "call" ? factCallOps(key, source) : null;
      }
      return ops;
    },
  };
}
