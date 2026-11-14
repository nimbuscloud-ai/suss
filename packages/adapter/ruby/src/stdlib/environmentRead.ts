/**
 * What the environment chain says one expression reads, asked over the
 * facts. The rule for whether the program copes with a missing value
 * asks it about a read and about the tests around it, so the rule and
 * the chain agree on what counts as a read.
 */

import { readSpellingsOf, siteReadOf } from "@suss/recognize";
import { factCallOps, factReadOps } from "@suss/recognize/ops";

import { resolutionKeyOf } from "../values/evaluator.js";
import { ENVIRONMENT } from "./environment.js";

import type { SiteRead } from "@suss/recognize";
import type { RubyFactSource } from "../factSource.js";
import type { RbNode } from "../parser.js";

const PATHS = readSpellingsOf(ENVIRONMENT.declared).paths;

/**
 * What the environment chain says the expression reads, or null for an
 * expression it doesn't read. Only an element reference or a call can
 * read an entry of a mapping.
 */
export function environmentReadAt(
  node: RbNode,
  source: RubyFactSource,
): SiteRead | null {
  if (node.type !== "element_reference" && node.type !== "call") {
    return null;
  }
  const key = resolutionKeyOf(node);
  if (key === null) {
    return null;
  }
  return siteReadOf(ENVIRONMENT.declared, {
    read: factReadOps(key, source),
    ops: node.type === "call" ? factCallOps(key, source) : null,
  });
}

/** Whether the expression is spelled as the object the environment chain reads, `ENV`. */
export function spellsEnvironment(
  node: RbNode,
  source: RubyFactSource,
): boolean {
  const key = resolutionKeyOf(node);
  return (
    key !== null &&
    PATHS.some((path) => source.spellsGlobal?.(key, path) === true)
  );
}
