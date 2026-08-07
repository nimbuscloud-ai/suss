// ast.ts: small, named helpers over a tree-sitter Python node.
//
// Nothing here is Python-specific beyond the node-type strings, which
// come straight from tree-sitter-python's grammar (see
// grammar/README.md for the exact version they were read against).
// Everything downstream (scope.ts, decorators.ts, annotations.ts,
// discovery.ts) reads a node through these instead of calling
// `childForFieldName` / `.type` inline, so a grammar bump that renames
// a field shows up in one place.

import type { PyNode } from "./parser.js";

export interface Range {
  start: number;
  end: number;
}

export function rangeOf(node: PyNode): Range {
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

/**
 * The literal text a Python string node holds, unquoted. Returns null
 * for anything other than a plain, non-interpolated string (no
 * f-strings): a route path or a decorator argument built at runtime
 * isn't a literal, and callers that need a literal treat a non-literal
 * the same as absent.
 */
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
      // An f-string with an interpolated segment isn't a literal.
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

/**
 * Top-level statements of a module or a class/function body, skipping
 * wrapper nodes (`decorated_definition`, `expression_statement`) that
 * exist to attach syntax to a statement rather than to hold one of
 * their own.
 */
export function bodyStatements(body: PyNode): PyNode[] {
  return body.namedChildren.filter((child): child is PyNode => child !== null);
}

/**
 * The definition a statement carries, once decorators are stripped.
 * `@route("/x")\ndef f(): ...` and `def f(): ...` both come back as
 * the same `function_definition` node; the decorators (if any) are the
 * second element.
 */
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
