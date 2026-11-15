/**
 * Hands the read chains this adapter declares for Python's standard
 * library every site a body reads at, and places what they report at
 * the site, in source order. Which sites a body owns is this adapter's
 * walk: a nested def or lambda waits for its own unit.
 */

import { SKIP_CHILDREN, walkDescendants } from "@suss/extractor";
import { factCallOps, factReadOps } from "@suss/recognize/ops";

import { children, rangeOf } from "../ast.js";
import { resolveHelperCallees } from "../envReads.js";
import { factSourceOf } from "../factSource.js";
import { resolutionKeyOf } from "../values/evaluator.js";
import { environmentReads } from "./environment.js";

import type { Database } from "@suss/datalog";
import type { CallOps, FactSource, ReadOps } from "@suss/extractor";
import type { PyNode } from "../parser.js";
import type { EffectAt } from "../paths/effects.js";

/** A nested function's reads happen when it is called, so its body waits for its own unit. */
const DEFERRED_BODY_TYPES = new Set(["function_definition", "lambda"]);

/** The nodes a read can be at: a key, a member and a call. */
const SITE_TYPES = new Set(["subscript", "attribute", "call"]);

/**
 * The environment reads under `root`, in source order, each at the node
 * it was read at. `root` itself is not read: pass a unit's function for
 * its body, or the module node for what runs at import time.
 */
export function stdlibReads(root: PyNode, db: Database): EffectAt[] {
  const sites = sitesUnder(root);
  resolveHelperCallees(
    db,
    sites.filter((node) => node.type === "call"),
  );
  const source = factSourceOf(db);
  return sites.flatMap((node) => {
    const key = resolutionKeyOf(node, db);
    const effects =
      key === null
        ? null
        : environmentReads(node, siteContext(key, node, source));
    return (effects ?? []).map((effect) => ({
      effect: { ...effect, location: rangeOf(node) },
      at: node,
    }));
  });
}

function sitesUnder(root: PyNode): PyNode[] {
  const sites: PyNode[] = [];
  walkDescendants<PyNode, null>(root, null, children, {
    at: (node) => {
      if (SITE_TYPES.has(node.type)) {
        sites.push(node);
      }
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
