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

/**
 * The lines a node spans, counting from one.
 *
 * A summary's `location.range` is a line number everywhere else in the
 * IR: the TypeScript adapter fills it from `getStartLineNumber`, and
 * `suss inspect` prints it as "line N". tree-sitter counts bytes and
 * rows instead, and handing back the byte offset put `line 348` on a
 * 12-line file.
 */
export function rangeOf(node: RbNode): Range {
  return {
    start: node.startPosition.row + 1,
    end: node.endPosition.row + 1,
  };
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

/**
 * Every instance method a class body defines directly, keyed by the
 * name it is defined under. A name defined twice keeps the later
 * definition, the way Ruby's own redefinition does.
 *
 * `def self.name` parses as a `singleton_method` and is deliberately
 * not one of these: it runs on the class, and what resolves a field is
 * an instance method.
 */
export function instanceMethodsByName(body: RbNode): Map<string, RbNode> {
  const methods = new Map<string, RbNode>();
  for (const stmt of bodyStatements(body)) {
    if (stmt.type !== "method") {
      continue;
    }
    const name = field(stmt, "name")?.text;
    if (name !== undefined) {
      methods.set(name, stmt);
    }
  }
  return methods;
}

/**
 * The arguments of each receiverless call to `name` written directly in
 * `body`, one group per call, in source order. Grouped rather than
 * flattened because `include A, B` and `include A` then `include B`
 * order their modules differently.
 */
export function bareCallArgumentGroups(body: RbNode, name: string): RbNode[][] {
  const groups: RbNode[][] = [];
  for (const stmt of bodyStatements(body)) {
    if (stmt.type !== "call" || field(stmt, "receiver") !== null) {
      continue;
    }
    if (field(stmt, "method")?.text !== name) {
      continue;
    }
    const args = field(stmt, "arguments");
    groups.push(args === null ? [] : bodyStatements(args));
  }
  return groups;
}

/**
 * Whether a method has work in it. `def name; end` has no `body` field
 * at all; an endless `def name = expr` has the expression itself there
 * rather than a `body_statement`, and that is work.
 */
export function methodHasStatements(method: RbNode): boolean {
  const body = field(method, "body");
  if (body === null) {
    return false;
  }
  if (body.type !== "body_statement") {
    return true;
  }
  return bodyStatements(body).length > 0;
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
