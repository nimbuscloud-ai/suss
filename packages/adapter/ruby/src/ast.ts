/**
 * Small helpers for reading a tree-sitter-ruby parse tree.
 *
 * The node-type strings here come from tree-sitter-ruby's grammar, at the
 * version the grammar README gives. Read a node through these helpers rather
 * than calling `childForFieldName` or `.type` inline, so that a grammar upgrade
 * that renames a field only has to be fixed in one place.
 */

import type { RbNode } from "./parser.js";

export interface Range {
  start: number;
  end: number;
}

/** Lines, counting from one, because a summary's `location.range` is lines everywhere else in the IR. */
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

export function bodyStatements(body: RbNode): RbNode[] {
  return body.namedChildren.filter((child): child is RbNode => child !== null);
}

/** tree-sitter-ruby leaves the leading colon in a `simple_symbol`'s text, but not in a `hash_key_symbol`'s. */
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

/** A `pair` node's key, when it is written as the bare `key:` shorthand. Null for a pair keyed by a string or an expression. */
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

/** Keyword arguments turn up as `pair` nodes directly among the argument list's children, rather than wrapped in a hash node. */
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

/**
 * tree-sitter hands back a fresh wrapper object every time a child is read,
 * so two reads of one node are never `===`. Anything keyed on a node keys on
 * `nodeKey`, which is why these exist rather than a plain Set and Map.
 */
export function nodeKey(node: RbNode): number {
  return node.id;
}

/** A set of nodes, compared the way tree-sitter compares them. */
export class NodeSet implements Iterable<RbNode> {
  private readonly byKey = new Map<number, RbNode>();

  constructor(nodes: Iterable<RbNode> = []) {
    for (const node of nodes) {
      this.add(node);
    }
  }

  add(node: RbNode): this {
    this.byKey.set(nodeKey(node), node);
    return this;
  }

  has(node: RbNode): boolean {
    return this.byKey.has(nodeKey(node));
  }

  /** The node this set was built with, which is the caller's own handle for it. */
  get(node: RbNode): RbNode | undefined {
    return this.byKey.get(nodeKey(node));
  }

  get size(): number {
    return this.byKey.size;
  }

  [Symbol.iterator](): Iterator<RbNode> {
    return this.byKey.values();
  }
}

/** A map keyed by node, compared the way tree-sitter compares them. */
export class NodeMap<V> implements Iterable<[RbNode, V]> {
  private readonly entries = new Map<number, [RbNode, V]>();

  set(node: RbNode, value: V): this {
    this.entries.set(nodeKey(node), [node, value]);
    return this;
  }

  get(node: RbNode): V | undefined {
    return this.entries.get(nodeKey(node))?.[1];
  }

  has(node: RbNode): boolean {
    return this.entries.has(nodeKey(node));
  }

  get size(): number {
    return this.entries.size;
  }

  [Symbol.iterator](): Iterator<[RbNode, V]> {
    return this.entries.values();
  }
}
