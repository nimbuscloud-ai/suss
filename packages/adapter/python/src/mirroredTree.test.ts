/**
 * The copied tree `parsePython` returns has to read the same as tree-sitter's
 * own nodes, node for node. This parses every Python fixture both ways and
 * compares each node's type, span, text, line, field and children, then
 * the searches the adapter makes over a tree.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { Language, type Node, Parser } from "web-tree-sitter";

import { type PyNode, parsePython } from "./parser.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GRAMMAR = path.join(HERE, "..", "grammar", "tree-sitter-python.wasm");
const FIXTURES = path.join(HERE, "..", "..", "..", "..", "fixtures");

function filesUnder(
  dir: string,
  extension: string,
  found: string[] = [],
): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules") {
      filesUnder(full, extension, found);
    } else if (entry.name.endsWith(extension)) {
      found.push(full);
    }
  }
  return found;
}

const spanOf = (
  node: { type: string; startIndex: number; endIndex: number } | null,
) =>
  node === null ? null : `${node.type}@${node.startIndex}-${node.endIndex}`;

/** Every difference between the two trees under these nodes, as a short line each. */
function differences(own: Node, copy: PyNode, found: string[] = []): string[] {
  const at = spanOf(own);
  const pairs: Array<[string, unknown, unknown]> = [
    ["type", own.type, copy.type],
    ["isNamed", own.isNamed, copy.isNamed],
    ["isMissing", own.isMissing, copy.isMissing],
    ["start", own.startIndex, copy.startIndex],
    ["end", own.endIndex, copy.endIndex],
    ["text", own.text, copy.text],
    ["startRow", own.startPosition.row, copy.startPosition.row],
    ["endRow", own.endPosition.row, copy.endPosition.row],
    ["childCount", own.childCount, copy.childCount],
    ["namedChildCount", own.namedChildCount, copy.namedChildCount],
  ];
  for (const [what, expected, actual] of pairs) {
    if (expected !== actual) {
      found.push(`${at} ${what}: ${String(expected)} vs ${String(actual)}`);
    }
  }
  for (let index = 0; index < own.childCount; index++) {
    const ownChild = own.child(index);
    const copyChild = copy.child(index);
    if (ownChild === null || copyChild === null) {
      continue;
    }
    if (own.fieldNameForChild(index) !== copyChild.fieldName) {
      found.push(`${at} field of child ${index}`);
    }
    const field = copyChild.fieldName;
    if (
      field !== null &&
      spanOf(own.childForFieldName(field)) !==
        spanOf(copy.childForFieldName(field))
    ) {
      found.push(`${at} childForFieldName(${field})`);
    }
    differences(ownChild, copyChild, found);
  }
  for (let index = 0; index < own.namedChildCount; index++) {
    if (spanOf(own.namedChild(index)) !== spanOf(copy.namedChild(index))) {
      found.push(`${at} namedChild(${index})`);
    }
  }
  return found;
}

describe("the tree parsePython copies", () => {
  it("reads like tree-sitter's own nodes in every Python fixture", async () => {
    await Parser.init();
    const language = await Language.load(GRAMMAR);
    const sources = [
      ...filesUnder(FIXTURES, ".py").map((file) =>
        fs.readFileSync(file, "utf8"),
      ),
      'name = "naïve ☃ 😀"\nprint(name)\n',
      "def broken(\n  x = \n",
    ];
    expect(sources.length).toBeGreaterThan(20);
    for (const source of sources) {
      const parser = new Parser();
      parser.setLanguage(language);
      const own = parser.parse(source);
      parser.delete();
      const copy = await parsePython(source);
      if (own === null) {
        throw new Error("tree-sitter gave no tree");
      }
      expect(differences(own.rootNode, copy.rootNode)).toEqual([]);
      expect(copy.rootNode.hasError).toBe(own.rootNode.hasError);
      for (const type of ["identifier", "call", "function_definition"]) {
        expect(copy.rootNode.descendantsOfType(type).map(spanOf)).toEqual(
          own.rootNode.descendantsOfType(type).map(spanOf),
        );
      }
      // The ranges the adapter looks a node up by: each call's own span.
      for (const call of own.rootNode.descendantsOfType("call")) {
        const start = call.startIndex;
        const end = Math.max(start, call.endIndex - 1);
        expect(spanOf(copy.rootNode.descendantForIndex(start, end))).toBe(
          spanOf(own.rootNode.descendantForIndex(start, end)),
        );
      }
      own.delete();
    }
  });

  it("gives each node one object for as long as the tree is kept", async () => {
    const tree = await parsePython("def f():\n    g(1)\n");
    const method = tree.rootNode.namedChild(0);
    expect(method?.parent).toBe(tree.rootNode);
    expect(method?.tree).toBe(tree);
    expect(tree.rootNode.namedChild(0)).toBe(method);
  });
});
