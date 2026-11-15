/**
 * Hands the chains this adapter declares for Python's standard library
 * every site a body reads or writes at, and places what they report at
 * the site, in source order. Which sites a body owns is this adapter's
 * walk: a nested def or lambda waits for its own unit.
 */

import {
  locatedBeforeGroupId,
  numberRepeatedCallSites,
  SKIP_CHILDREN,
  walkDescendants,
} from "@suss/extractor";
import { factCallOps, factReadOps } from "@suss/recognize/ops";

import { children, rangeOf } from "../ast.js";
import { resolveHelperCallees } from "../envReads.js";
import { factSourceOf } from "../factSource.js";
import { resolutionKeyOf } from "../values/evaluator.js";
import { environmentReads } from "./environment.js";
import { streamWriteHooks } from "./streams.js";

import type { Database } from "@suss/datalog";
import type { CallOps, FactSource, ReadOps } from "@suss/extractor";
import type { PyNode } from "../parser.js";
import type { EffectAt } from "../paths/effects.js";

/** A nested function's reads happen when it is called, so its body waits for its own unit. */
const DEFERRED_BODY_TYPES = new Set(["function_definition", "lambda"]);

/** The nodes a read can be at: a key, a member and a call. */
const SITE_TYPES = new Set(["subscript", "attribute", "call"]);

/** The ops a chain asks of one site. */
interface SiteContext {
  readonly read: ReadOps;
  readonly ops: CallOps | null;
}

/** A site the walk visited, with its ops, or null for a node the facts give no key. */
interface Site {
  readonly node: PyNode;
  readonly context: SiteContext | null;
}

/**
 * The environment reads under `root`, in source order, each at the node
 * it was read at. `root` itself is not read: pass a unit's function for
 * its body, or the module node for what runs at import time.
 */
export function stdlibReads(root: PyNode, db: Database): EffectAt[] {
  return readsAt(sitesUnder(root, db), db);
}

/**
 * The environment reads and the stream writes under `root`, from one
 * walk, each at the node it was made at. A unit places the two apart,
 * in the slots its body's effects go in.
 */
export function stdlibEffects(
  root: PyNode,
  db: Database,
): { reads: EffectAt[]; writes: EffectAt[] } {
  const sites = sitesUnder(root, db);
  return { reads: readsAt(sites, db), writes: writesAt(sites) };
}

function readsAt(sites: readonly Site[], db: Database): EffectAt[] {
  resolveHelperCallees(
    db,
    sites.flatMap(({ node }) => (node.type === "call" ? [node] : [])),
  );
  return sites.flatMap(({ node, context }) => {
    const effects = context === null ? null : environmentReads(node, context);
    return (effects ?? []).map((effect) => ({
      effect: { ...effect, location: rangeOf(node) },
      at: node,
    }));
  });
}

/** The writes, one list per call, with a write repeated in the body numbered. */
function writesAt(sites: readonly Site[]): EffectAt[] {
  const calls = sites.filter(
    (site): site is Site & { context: SiteContext } =>
      site.node.type === "call" && site.context !== null,
  );
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

function sitesUnder(root: PyNode, db: Database): Site[] {
  const source = factSourceOf(db);
  const sites: Site[] = [];
  walkDescendants<PyNode, null>(root, null, children, {
    at: (node) => {
      if (!SITE_TYPES.has(node.type)) {
        return;
      }
      const key = resolutionKeyOf(node, db);
      sites.push({
        node,
        context: key === null ? null : siteContext(key, node, source),
      });
    },
    into: (node) => (DEFERRED_BODY_TYPES.has(node.type) ? SKIP_CHILDREN : null),
  });
  return sites;
}

/** The ops a chain asks of one site, each built the first time it is asked for. */
function siteContext(
  key: string,
  node: PyNode,
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
        ops = node.type === "call" ? factCallOps(key, source) : null;
      }
      return ops;
    },
  };
}
