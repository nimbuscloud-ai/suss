// ast.ts: small, named helpers over a tree-sitter Ruby node.
//
// Nothing here is Ruby-specific beyond the node-type strings, which
// come straight from tree-sitter-ruby's grammar (see grammar/README.md
// for the exact version they were read against). Everything downstream
// (scope.ts, typeShape.ts, discovery.ts) reads a node through these
// instead of calling `childForFieldName` / `.type` inline, so a grammar
// bump that renames a field shows up in one place.

import type { RbNode } from "./parser.js";

export interface Range {
  start: number;
  end: number;
}

export function rangeOf(node: RbNode): Range {
  return { start: node.startIndex, end: node.endIndex };
}

export function field(node: RbNode, name: string): RbNode | null {
  return node.childForFieldName(name);
}

export function isType(node: RbNode, ...types: string[]): boolean {
  return types.includes(node.type);
}

/**
 * A `program`, `body_statement`, or `argument_list` node's own direct
 * statements/children, skipping absent slots. tree-sitter-ruby has no
 * wrapper node comparable to Python's `decorated_definition`, so this
 * is a plain `namedChildren` filter.
 */
export function bodyStatements(body: RbNode): RbNode[] {
  return body.namedChildren.filter((child): child is RbNode => child !== null);
}

/**
 * The name a `simple_symbol` literal holds, unquoted. tree-sitter-ruby
 * keeps the leading colon in a `simple_symbol` node's own text
 * (`:campaign` → `"campaign"`), unlike a `hash_key_symbol` (see
 * `hashKeySymbolName`), which never carries one. Returns null for
 * anything else (a `delimited_symbol` with interpolation, a string, a
 * method call): v0 reads only the plain literal form, matching the
 * measured corpus's dominant shape.
 */
export function symbolValue(node: RbNode): string | null {
  return node.type === "simple_symbol" ? node.text.slice(1) : null;
}

/** A `pair` node's key, when it is a bare `key:` shorthand symbol (the shape every class-DSL keyword argument in the measured corpus uses). Null for a string- or expression-keyed pair, which v0 does not read. */
export function hashKeySymbolName(node: RbNode): string | null {
  return node.type === "hash_key_symbol" ? node.text : null;
}

export function booleanLiteralValue(node: RbNode): boolean | null {
  if (node.type === "true") {
    return true;
  }
  if (node.type === "false") {
    return false;
  }
  return null;
}

/** A `call` node's positional and keyword arguments, read off its `argument_list`. Keyword arguments are `pair` nodes directly among the argument list's children (Ruby's trailing `key: value` shorthand), not wrapped in a separate hash node. */
export interface CallArgs {
  positional: RbNode[];
  keyword: Record<string, RbNode>;
}

export function readCallArgs(argumentList: RbNode | null): CallArgs {
  const positional: RbNode[] = [];
  const keyword: Record<string, RbNode> = {};
  if (argumentList === null) {
    return { positional, keyword };
  }
  for (const child of bodyStatements(argumentList)) {
    if (child.type === "pair") {
      const keyNode = field(child, "key");
      const valueNode = field(child, "value");
      const name = keyNode !== null ? hashKeySymbolName(keyNode) : null;
      if (name !== null && valueNode !== null) {
        keyword[name] = valueNode;
      }
      continue;
    }
    positional.push(child);
  }
  return { positional, keyword };
}
