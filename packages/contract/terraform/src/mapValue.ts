/**
 * Resolves the map a `for_each` iterates over, which decides how many
 * times a block is written.
 *
 * A reader that cannot resolve `for_each` sees a container with no
 * environment at all. Most of what a module iterates over is written
 * down: a map literal, a `locals` entry, a `variable` default, or a
 * `merge` of those.
 *
 * Only this module reads a `variable` default. A default is a guess at
 * what the deployment passes in, so a `${var.x}` in a name stays a
 * hole. Here the default only decides which keys exist, and each
 * expanded block keeps its values as the module wrote them.
 */

import { parseHclExpression } from "./hclDocument.js";
import { asRecord } from "./hclValue.js";

import type { ReferenceScope } from "./references.js";

/** A value that is one interpolation and no text of its own. */
const WHOLE_INTERPOLATION = /^\$\{([\s\S]*)\}$/;

/** `merge(a, b)`, whose arguments are maps in their own right. */
const MERGE_CALL = /^merge\(([\s\S]*)\)$/;

/** `local.name`, which a `locals` block states in the same module. */
const LOCAL_MAP = /^local\.([A-Za-z_][\w-]*)$/;

/** `var.name`, which a module call or a `variable` default may state. */
const VARIABLE_MAP = /^var\.([A-Za-z_][\w-]*)$/;

/**
 * How many hops of one map referring to another are followed. A `merge`
 * of locals that merge further locals resolves in one or two hops.
 */
const CHAIN_LIMIT = 4;

/** A comma inside any of these brackets does not split arguments. */
const OPENERS = "([{";
const CLOSERS = ")]}";

/** The map an expression resolves to, or null when it cannot be resolved. */
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
    // What the call passed in is what the deployment runs with, so the
    // `variable` block's own default only fills a gap the call left.
    const name = variable[1] as string;
    return (
      mapFrom(scope.arguments[name], scope, depth + 1) ??
      mapFrom(scope.defaults[name], scope, depth + 1)
    );
  }
  return null;
}

/**
 * Null when any argument is unresolved, because a merge missing a part
 * would list fewer keys than the deployment has, which is worse than
 * listing none.
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
