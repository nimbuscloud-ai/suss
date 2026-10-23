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

import { answersFor, askResolution, spanOfKey } from "@suss/resolution";

import { blocksDefinedIn } from "./ancestry.js";
import { NESTING_TYPES } from "./ast.js";
import { RUBY_PROGRAM } from "./facts/resolve.js";
import { nodeId } from "./facts/values.js";

import type { Database } from "@suss/datalog";
import type { AncestorLookup, ReachedBody } from "./ancestry.js";
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
 * The class the rules settle a value on, when they settle on exactly
 * one. With two, picking either would be a guess, so the result is
 * undefined, as it is for the constant bindings. The rules follow a
 * constant through an alias the same way they follow a call's receiver.
 */
export function classSettledOn(
  facts: Database,
  key: string,
): string | undefined {
  askResolution(facts, [key], "wanted", RUBY_PROGRAM);
  const objects = answersFor(facts, "wantedObjectOf", key);
  return objects.length === 1 ? objects[0] : undefined;
}

/**
 * The name a class is declared under, which is how a constant receiver
 * would have written it. A class reopened in several files binds to one
 * of them, so only one name comes back.
 */
export function declaredName(
  facts: Database,
  classKey: string,
): string | undefined {
  const names = new Set(
    facts.lookup("rbConstantName", 0, classKey).map((row) => String(row[1])),
  );
  return names.size === 1 ? [...names][0] : undefined;
}

/**
 * Finds a class by its full name in whichever files of the run declare
 * it, so a lookup does not depend on the file being where a naming
 * convention puts it. A class reopened in several files gives the blocks
 * of each. Null when no file in the run declares it.
 */
export function classesDeclaredInRun(
  facts: Database,
  parsedFile: AncestorLookup["parsedFile"],
): (qualifiedName: string) => Promise<ReachedBody[] | null> {
  const known = new Map<string, Promise<ReachedBody[] | null>>();
  const read = async (qualifiedName: string) => {
    const files = new Set<string>();
    for (const row of facts.lookup("rbConstantName", 1, qualifiedName)) {
      const span = spanOfKey(String(row[0]));
      if (span !== null) {
        files.add(span.file);
      }
    }
    const blocks: ReachedBody[] = [];
    for (const file of files) {
      blocks.push(
        ...((await blocksDefinedIn(file, qualifiedName, parsedFile)) ?? []),
      );
    }
    return blocks.length === 0 ? null : blocks;
  };
  return (qualifiedName) => {
    let found = known.get(qualifiedName);
    if (found === undefined) {
      found = read(qualifiedName);
      known.set(qualifiedName, found);
    }
    return found;
  };
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
