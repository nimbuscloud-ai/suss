/**
 * Small helpers for reading a tree-sitter-python parse tree.
 *
 * The node-type strings here come from tree-sitter-python's grammar, at the
 * version the grammar README gives. Read a node through these helpers rather
 * than calling `childForFieldName` or `.type` inline, so that a grammar upgrade
 * that renames a field only has to be fixed in one place.
 */

import type { PyNode } from "./parser.js";

export interface Range {
  start: number;
  end: number;
}

/** Lines, counting from one, because a summary's `location.range` is lines everywhere else in the IR. */
export function rangeOf(node: PyNode): Range {
  return {
    start: node.startPosition.row + 1,
    end: node.endPosition.row + 1,
  };
}

export function field(node: PyNode, name: string): PyNode | null {
  return node.childForFieldName(name);
}

export function fields(node: PyNode, name: string): PyNode[] {
  return node.childrenForFieldName(name);
}

export function isType(node: PyNode, ...types: string[]): boolean {
  return types.includes(node.type);
}

/** The text inside a plain string node, with the quotes removed. An f-string returns null. */
export function stringLiteralValue(node: PyNode): string | null {
  if (node.type !== "string") {
    return null;
  }
  let content = "";
  for (const child of node.namedChildren) {
    if (child === null) {
      continue;
    }
    if (child.type === "string_content") {
      content += child.text;
      continue;
    }
    if (child.type === "interpolation") {
      return null;
    }
  }
  return content;
}

export function booleanLiteralValue(node: PyNode): boolean | null {
  if (node.type === "true") {
    return true;
  }
  if (node.type === "false") {
    return false;
  }
  return null;
}

export function bodyStatements(body: PyNode): PyNode[] {
  return body.namedChildren.filter((child): child is PyNode => child !== null);
}

export function stripDecorators(node: PyNode): {
  definition: PyNode;
  decorators: PyNode[];
} {
  if (node.type !== "decorated_definition") {
    return { definition: node, decorators: [] };
  }
  const definition = field(node, "definition");
  if (definition === null) {
    throw new Error("decorated_definition with no definition field");
  }
  const decorators = node.namedChildren.filter(
    (child): child is PyNode => child !== null && child.type === "decorator",
  );
  return { definition, decorators };
}
