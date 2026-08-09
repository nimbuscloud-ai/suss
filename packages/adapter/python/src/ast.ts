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

/**
 * tree-sitter hands back a fresh wrapper object every time a child is read,
 * so two reads of the same node are never `===`. Anything keyed on a node has
 * to key on `nodeKey` instead, which is why these two exist rather than a
 * plain Set and Map. `checkStyle` fails a build that keys either on a node.
 */
export function nodeKey(node: PyNode): number {
  return node.id;
}

/** A set of nodes, compared the way tree-sitter compares them. */
export class NodeSet implements Iterable<PyNode> {
  private readonly byKey = new Map<number, PyNode>();

  constructor(nodes: Iterable<PyNode> = []) {
    for (const node of nodes) {
      this.add(node);
    }
  }

  add(node: PyNode): this {
    this.byKey.set(nodeKey(node), node);
    return this;
  }

  has(node: PyNode): boolean {
    return this.byKey.has(nodeKey(node));
  }

  /** The node this set was built with, which is the caller's own handle for it. */
  get(node: PyNode): PyNode | undefined {
    return this.byKey.get(nodeKey(node));
  }

  get size(): number {
    return this.byKey.size;
  }

  [Symbol.iterator](): Iterator<PyNode> {
    return this.byKey.values();
  }
}

/** A map keyed by node, compared the way tree-sitter compares them. */
export class NodeMap<V> implements Iterable<[PyNode, V]> {
  private readonly entries = new Map<number, [PyNode, V]>();

  set(node: PyNode, value: V): this {
    this.entries.set(nodeKey(node), [node, value]);
    return this;
  }

  get(node: PyNode): V | undefined {
    return this.entries.get(nodeKey(node))?.[1];
  }

  has(node: PyNode): boolean {
    return this.entries.has(nodeKey(node));
  }

  get size(): number {
    return this.entries.size;
  }

  [Symbol.iterator](): Iterator<[PyNode, V]> {
    return this.entries.values();
  }
}
