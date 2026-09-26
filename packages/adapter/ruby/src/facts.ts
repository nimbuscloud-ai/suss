/**
 * The facts discovery adds to the shared fact store, next to the units
 * and summaries it produces.
 *
 * `entry` is the relation every adapter uses for a unit a pack
 * discovered, so a Ruby field is an entry the same way a Python route or
 * a TypeScript handler is.
 *
 * `importsFile(from, to)` records a `require_relative` whose target is a
 * file in the run. A plain `require` goes through the load path, which
 * the adapter does not know, so it records nothing.
 */

import path from "node:path";

import { SKIP_CHILDREN, walkDescendants } from "@suss/extractor";

import { field, readCallArgs, stringLiteralValue } from "./ast.js";

import type { Database } from "@suss/datalog";
import type { RbNode } from "./parser.js";

/**
 * The key includes the name because the range is measured in lines and two
 * units can start on the same line. `entry` is a set, so a key on the range
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

/** Counts a `require_relative` inside a method too. It runs only when the method does, but the file still depends on its target. */
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
        db.add("importsFile", [filePath, resolved]);
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
