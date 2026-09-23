/**
 * Which class is behind a receiver, and whether that class inherits from
 * one of the base classes a pack listed.
 *
 * Ruby code declares no types, so a recognizer matches a call by what its
 * receiver inherits from. Each recognizer needs the same two answers:
 * which class a constant refers to, and whether that class reaches a
 * listed base. A call with no receiver also needs the class it is
 * written inside.
 *
 * All three go through the constant bindings and the shared resolution
 * rules, so the model recognizer and the raw SQL recognizer settle every
 * class the same way.
 */

import { askResolution } from "@suss/resolution";

import { NESTING_TYPES } from "./ast.js";
import { RUBY_PROGRAM } from "./facts/resolve.js";
import { nodeId } from "./facts/values.js";

import type { Database } from "@suss/datalog";
import type { RbNode } from "./parser.js";

/**
 * The class a constant refers to. The constant bindings key a bare name
 * once per file and a compound path once per node. Returns undefined when
 * two classes are bound, since picking one would be a guess.
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
 * Whether a class inherits from one of the given base classes. The shared
 * ancestry rules follow each superclass through its binding. A base class
 * from the library has no node in the run, so it is matched by the name
 * the project wrote.
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
 * The key of the class or module body a node is written inside. Null at
 * the top level of a file, where a call with no receiver inherits nothing.
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
