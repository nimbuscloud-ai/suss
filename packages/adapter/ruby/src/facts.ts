/**
 * facts.ts: what discovery hands to the shared fact store.
 *
 * This is the Layer 1 contract: discover units, emit summaries, emit
 * these facts.
 *
 * `entry` reuses the existing relation name and shape, where the unit
 * is a pack-discovered entry point, so a Ruby-discovered field is an
 * entry the same way a Python route or a TypeScript handler is.
 *
 * `rbRequires(from, to)` records a `require_relative` whose target is a
 * file in the run. A plain `require` goes through the load path, which
 * this run does not know, so it records nothing.
 */

import path from "node:path";

import { SKIP_CHILDREN, walkDescendants } from "@suss/extractor";

import { field, readCallArgs, stringLiteralValue } from "./ast.js";

import type { Database } from "@suss/datalog";
import type { RbNode } from "./parser.js";

/**
 * The name is part of the key because the range is measured in lines, two
 * units can start on the same line, and `entry` is a set, so keying on the range
 * alone would drop one of them.
 */
export function unitKey(
  filePath: string,
  range: { start: number; end: number },
  name: string,
): string {
  return `${filePath}:${range.start}-${range.end}#${name}`;
}

export function emitEntryFact(
  db: Database,
  filePath: string,
  range: { start: number; end: number },
  name: string,
): void {
  db.add("entry", [unitKey(filePath, range, name)]);
}

/** A `require_relative` in a method runs when the method does, which is still this file requiring that one. */
export function emitRequireFacts(
  db: Database,
  filePath: string,
  root: RbNode,
  known: ReadonlySet<string>,
): void {
  walkDescendants<RbNode, null>(root, null, {
    at: (node) => {
      const target = requiredRelativePath(node);
      if (target === null) {
        return;
      }
      const resolved = path.resolve(
        path.dirname(filePath),
        target.endsWith(".rb") ? target : `${target}.rb`,
      );
      if (known.has(resolved)) {
        db.add("rbRequires", [filePath, resolved]);
      }
    },
    into: (node) => (node.type === "argument_list" ? SKIP_CHILDREN : null),
  });
}

function requiredRelativePath(node: RbNode): string | null {
  if (
    node.type !== "call" ||
    field(node, "receiver") !== null ||
    field(node, "method")?.text !== "require_relative"
  ) {
    return null;
  }
  const { positional } = readCallArgs(field(node, "arguments"));
  return positional[0] === undefined ? null : stringLiteralValue(positional[0]);
}
