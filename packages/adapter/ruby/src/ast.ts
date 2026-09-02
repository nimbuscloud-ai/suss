import { IdMap, IdSet, SKIP_CHILDREN, walkDescendants } from "@suss/extractor";

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

/** Byte offsets, which identity measures with; lines above are for reading. */
export function spanOf(node: RbNode): Range {
  return { start: node.startIndex, end: node.endIndex };
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

/**
 * A body written in one of these belongs to the thing it declares, so
 * its statements do not run when the enclosing body runs.
 */
export const OWN_BODY_TYPES = new Set([
  "method",
  "singleton_method",
  "lambda",
  "class",
  "module",
  "singleton_class",
]);

/** A call's arguments are values it is handed, not statements the body runs. */
const ARGUMENT_LIST_TYPE = "argument_list";

/** A call whose block is the thing being configured rather than a place statements run. */
export type BlockConfigures = (call: RbNode) => boolean;

/**
 * Every statement a body runs, in source order. Ruby runs a class body
 * like any other code, so a declaration can sit inside an `if`, a
 * `.each` block, a `begin` or a `class_eval`, and taking the body's own
 * child list finds the first spelling and loses the rest in silence.
 *
 * `blockConfigures` says which calls keep their block to themselves.
 * `field :x, String do argument :q, String end` declares an argument on
 * the field, not on the class, so that block is not part of the body.
 */
export function runStatements(
  body: RbNode,
  blockConfigures: BlockConfigures = () => false,
): RbNode[] {
  const found: RbNode[] = [];
  const readsItsChildren = (node: RbNode): boolean => {
    if (OWN_BODY_TYPES.has(node.type) || node.type === ARGUMENT_LIST_TYPE) {
      return false;
    }
    return !(node.type === "call" && blockConfigures(node));
  };
  walkDescendants<RbNode, null>(body, null, {
    at: (node) => {
      found.push(node);
    },
    into: (node) => (readsItsChildren(node) ? null : SKIP_CHILDREN),
  });
  return found;
}

/** The text inside a plain string node, with the quotes removed. A string with interpolation returns null. */
export function stringLiteralValue(node: RbNode): string | null {
  if (node.type !== "string") {
    return null;
  }
  let content = "";
  for (const child of bodyStatements(node)) {
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

/** tree-sitter-ruby leaves the leading colon in a `simple_symbol`'s text, but not in a `hash_key_symbol`'s. */
export function symbolValue(node: RbNode): string | null {
  return node.type === "simple_symbol" ? node.text.slice(1) : null;
}

/**
 * Every instance method a class body defines, keyed by the name it is
 * defined under. A name defined twice keeps the later definition, the
 * way Ruby's own redefinition does.
 *
 * `def self.name` parses as a `singleton_method` and is deliberately
 * not one of these: it runs on the class, and what resolves a field is
 * an instance method.
 */
export function instanceMethodsByName(body: RbNode): Map<string, RbNode> {
  const methods = new Map<string, RbNode>();
  for (const stmt of runStatements(body)) {
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
 * The arguments of each receiverless call to `name` the body runs, one
 * group per call, in source order. Grouped rather than flattened
 * because `include A, B` and `include A` then `include B` order their
 * modules differently.
 */
export function bareCallArgumentGroups(body: RbNode, name: string): RbNode[][] {
  const groups: RbNode[][] = [];
  for (const stmt of runStatements(body)) {
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
 * so two reads of one node are never `===`. These key on the node id, and
 * `checkStyle` fails a build that keys a plain Set or Map on a node.
 */
/** A set of nodes, compared the way tree-sitter compares them. */
export class NodeSet extends IdSet<RbNode> {}

/** A map keyed by node, compared the way tree-sitter compares them. */
export class NodeMap<V> extends IdMap<RbNode, V> {}
