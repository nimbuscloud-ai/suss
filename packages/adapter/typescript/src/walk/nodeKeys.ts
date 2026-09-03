/**
 * Position keys for AST nodes and summary locations.
 *
 * Three passes minted their own `file:start-end` strings, and two of
 * them spell identically while measuring different things: the
 * closure keys functions by character offsets, and rethrow enrichment
 * keys summaries by line numbers. A reader joining the two would get
 * silent misses, and the divergence audit that found them made
 * exactly that mistake (#674). The keys live here with their unit in
 * the name, so the difference is visible at every call site, and a
 * join across the two spellings has nowhere to look plausible.
 */

import { declarationKey } from "@suss/behavioral-ir";

import type { Node } from "ts-morph";

/**
 * A function node's identity within one run, by character offsets.
 * The reachable closure's `entry` and `calls` facts use these, and
 * `unitKeyBySummary` is how another pass joins to them.
 */
export function offsetKeyOf(node: Node): string {
  return offsetKeyFor(node.getSourceFile().getFilePath(), {
    start: node.getStart(),
    end: node.getEnd(),
  });
}

/**
 * The same key minted from a summary's `location.span`, so a summary
 * that records its offsets joins the closure's facts without the
 * closure in the room. It is the spelling the shared call linker
 * reads `declaredAt` with, so the two cannot drift apart.
 */
export function offsetKeyFor(
  file: string,
  span: { start: number; end: number },
): string {
  return declarationKey(file, span);
}

/**
 * A summary's location by line numbers, the way `location.range`
 * measures. Joinable only with keys minted by this same function.
 */
export function lineRangeKey(
  file: string,
  startLine: number,
  endLine: number,
): string {
  return `${file}:${startLine}-${endLine}`;
}

/**
 * A node's position with its syntax kind, for indexes that tell two
 * different nodes starting at one position apart.
 */
export function positionKindKeyOf(node: Node): string {
  return `${node.getSourceFile().getFilePath()}:${node.getStart()}:${node.getKind()}`;
}
