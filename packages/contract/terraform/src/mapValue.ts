/**
 * The map an expression states, for the one caller that has to know how
 * many times a block is written.
 *
 * `for_each` decides that, so a reader that leaves it unsettled sees a
 * container with no environment at all. Most of what a module iterates
 * over is written down: a map literal, a `locals` entry, a `variable`
 * default, or a `merge` of those.
 *
 * A `variable` default is read here and nowhere else. A default is a
 * guess about what the deployment passes in, so a `${var.x}` in a name
 * keeps its hole; here it only says which keys exist, and each block
 * the expansion writes still spells its values as the module wrote them.
 */

import { parseHclExpression } from "./hclDocument.js";

import type { ReferenceScope } from "./references.js";

/** A value that is one interpolation and no text of its own. */
const WHOLE_INTERPOLATION = /^\$\{([\s\S]*)\}$/;

/** `merge(a, b)`, whose arguments are maps in their own right. */
const MERGE_CALL = /^merge\(([\s\S]*)\)$/;

/** `local.name`, which a `locals` block states in the same module. */
const LOCAL_MAP = /^local\.([A-Za-z_][\w-]*)$/;

/** `var.name`, whose `variable` block may state a `default`. */
const VARIABLE_MAP = /^var\.([A-Za-z_][\w-]*)$/;

/**
 * How far a chain of one map referring to another is followed. A
 * `merge` of locals that merge further locals settles in one or two
 * hops, and past a few the expression is not one anybody is writing.
 */
const CHAIN_LIMIT = 4;

/** The brackets an argument list may nest before its next comma counts. */
const OPENERS = "([{";
const CLOSERS = ")]}";

/** Every key an expression states, or null when nothing settles it. */
export function statedMap(
  value: unknown,
  scope: ReferenceScope,
): Record<string, unknown> | null {
  return mapFrom(value, scope, 0);
}

function mapFrom(
  value: unknown,
  scope: ReferenceScope,
  depth: number,
): Record<string, unknown> | null {
  if (depth > CHAIN_LIMIT) {
    return null;
  }
  const record = asRecord(value);
  if (record !== null) {
    return record;
  }
  if (typeof value !== "string") {
    return null;
  }
  const inner = WHOLE_INTERPOLATION.exec(value.trim());
  return inner === null
    ? null
    : mapFromExpression((inner[1] as string).trim(), scope, depth);
}

function mapFromExpression(
  expression: string,
  scope: ReferenceScope,
  depth: number,
): Record<string, unknown> | null {
  const merged = MERGE_CALL.exec(expression);
  if (merged !== null) {
    return mergedMaps(splitArguments(merged[1] as string), scope, depth);
  }
  const local = LOCAL_MAP.exec(expression);
  if (local !== null) {
    return mapFrom(scope.locals[local[1] as string], scope, depth + 1);
  }
  const variable = VARIABLE_MAP.exec(expression);
  if (variable !== null) {
    return mapFrom(scope.defaults[variable[1] as string], scope, depth + 1);
  }
  return null;
}

/**
 * One map out of several, later arguments winning, or null when any of
 * them is unsettled. A merge missing one of its parts states fewer keys
 * than the deployment will, which is worse than stating none.
 */
function mergedMaps(
  argumentTexts: string[],
  scope: ReferenceScope,
  depth: number,
): Record<string, unknown> | null {
  const merged: Record<string, unknown> = {};
  for (const text of argumentTexts) {
    const stated = mapFrom(parseHclExpression(text), scope, depth + 1);
    if (stated === null) {
      return null;
    }
    Object.assign(merged, stated);
  }
  return merged;
}

/** One argument list, split at the commas that are not inside brackets. */
export function splitArguments(text: string): string[] {
  const found: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let at = 0; at < text.length; at += 1) {
    const character = text[at] as string;
    if (quoted) {
      quoted = character !== '"' || text[at - 1] === "\\";
      continue;
    }
    if (character === '"') {
      quoted = true;
    } else if (OPENERS.includes(character)) {
      depth += 1;
    } else if (CLOSERS.includes(character)) {
      depth -= 1;
    } else if (character === "," && depth === 0) {
      found.push(text.slice(start, at));
      start = at + 1;
    }
  }
  found.push(text.slice(start));
  return found
    .map((argument) => argument.trim())
    .filter((argument) => argument.length > 0);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
