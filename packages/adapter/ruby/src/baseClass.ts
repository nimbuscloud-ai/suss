/**
 * baseClass.ts: which class is behind a receiver, and whether it reaches
 * one of the base classes a pack listed.
 *
 * Ruby writes no types, so a recognizer matches a call by what its
 * receiver inherits from. Every one of them asks the same two questions:
 * which class is this constant, and does that class reach one of the base
 * classes the pack listed. A call written with no receiver asks a third,
 * which class it is written inside.
 *
 * All three go through the constant bindings and the shared resolution
 * rules, so the model recognizer and the raw SQL recognizer settle every
 * class the same way rather than each following its own chain.
 */

import { askResolution } from "@suss/resolution";

import { NESTING_TYPES } from "./ast.js";
import { RUBY_PROGRAM } from "./facts/resolve.js";
import { nodeId } from "./facts/values.js";

import type { Database } from "@suss/datalog";
import type { RbNode } from "./parser.js";

/**
 * The class a constant refers to, by the key the constant bindings gave this
 * reference: a bare name is bound once per file, a compound path once per
 * node. Two classes bound to it would make picking one a guess, so nothing
 * is said, the same caution the constant bindings apply.
 */
export function classBehind(
  facts: Database,
  file: string,
  constant: RbNode,
): string | undefined {
  const key =
    constant.type === "constant"
      ? `${file}#${constant.text}`
      : nodeId(file, constant);
  const bound = new Set(
    facts.lookup("binds", 0, key).map((row) => String(row[1])),
  );
  return bound.size === 1 ? [...bound][0] : undefined;
}

/**
 * Whether a class reaches one of the named base classes. The shared
 * ancestry rules follow what each one extends through the binding
 * behind it; a base the library gives is matched by the name it is
 * written as, since it has no node in the run to point at.
 */
export function reachesBase(
  facts: Database,
  classKey: string,
  bases: readonly string[],
): boolean {
  askResolution(facts, [classKey], "wantedAncestry", RUBY_PROGRAM);
  return facts
    .lookup("wantedBaseName", 0, classKey)
    .some((row) => bases.includes(String(row[1])));
}

/**
 * The class or module body a node is written inside, by the key the
 * constant bindings gave that declaration. Null at the top level of a
 * file, where a call with no receiver inherits nothing.
 */
export function enclosingClassKey(node: RbNode, file: string): string | null {
  let current = node.parent;
  while (current !== null) {
    if (NESTING_TYPES.has(current.type)) {
      return nodeId(file, current);
    }
    current = current.parent;
  }
  return null;
}
