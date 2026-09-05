import { IdMap, IdSet } from "@suss/extractor";

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

/** Byte offsets, which identity measures with; lines above are for reading. */
export function spanOf(node: PyNode): Range {
  return { start: node.startIndex, end: node.endIndex };
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

/** A `def` or a `lambda`: the nodes the facts treat as a function of their own. */
export function isFunction(node: PyNode): boolean {
  return node.type === "function_definition" || node.type === "lambda";
}

/** The nearest function a node is written inside, or null at module level. */
export function enclosingFunction(node: PyNode): PyNode | null {
  let current = node.parent;
  while (current !== null) {
    if (isFunction(current)) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

/**
 * The text of one `string_content` run, with an f-string's doubled braces
 * halved. Python serves `f"/v1/{{id}}"` at `/v1/{id}`, so a reader that kept
 * the doubling would pair the route with a path no request ever arrives at.
 * The grammar marks each doubled brace with an `escape_interpolation` child
 * and emits none of them for a plain string, which keeps its braces as
 * written.
 */
export function stringContentValue(content: PyNode): string {
  const base = content.startIndex;
  let text = "";
  let cursor = 0;
  for (const child of children(content)) {
    if (child.type !== "escape_interpolation") {
      continue;
    }
    text += content.text.slice(cursor, child.startIndex - base);
    text += child.text.slice(0, 1);
    cursor = child.endIndex - base;
  }
  return text + content.text.slice(cursor);
}

/** A parameter's name and the annotation written on it, across the four spellings the grammar gives a parameter. `*args` and `**kwargs` return null. */
export function parameterNameAndType(
  param: PyNode,
): { name: string; typeNode: PyNode | null } | null {
  if (param.type === "identifier") {
    return { name: param.text, typeNode: null };
  }
  if (param.type === "typed_parameter") {
    const inner = param.namedChildren.find(
      (child) => child !== null && child.type === "identifier",
    );
    return inner !== undefined
      ? { name: inner.text, typeNode: field(param, "type") }
      : null;
  }
  if (param.type === "default_parameter") {
    const nameNode = field(param, "name");
    return nameNode?.type === "identifier"
      ? { name: nameNode.text, typeNode: null }
      : null;
  }
  if (param.type === "typed_default_parameter") {
    const nameNode = field(param, "name");
    return nameNode !== null
      ? { name: nameNode.text, typeNode: field(param, "type") }
      : null;
  }
  return null;
}

/** The text inside a plain string node, with the quotes removed. An f-string with an interpolation returns null. */
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
      content += stringContentValue(child);
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

/** tree-sitter types a named child as nullable; dropping them once keeps every walk below flat. */
export function children(node: PyNode): PyNode[] {
  return node.namedChildren.filter((child): child is PyNode => child !== null);
}

export function bodyStatements(body: PyNode): PyNode[] {
  return children(body);
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
 * so two reads of one node are never `===`. These key on the node id, and
 * `checkStyle` fails a build that keys a plain Set or Map on a node.
 */
/** A set of nodes, compared the way tree-sitter compares them. */
export class NodeSet extends IdSet<PyNode> {}

/** A map keyed by node, compared the way tree-sitter compares them. */
export class NodeMap<V> extends IdMap<PyNode, V> {}
