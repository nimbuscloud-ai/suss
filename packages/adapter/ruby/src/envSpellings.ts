/**
 * envSpellings.ts: the ways Ruby source writes a read of one environment
 * variable. `ENV["X"]`, `ENV.fetch("X", d)` and `ENV.fetch("X") { d }`
 * all read `X`, off `ENV` written bare or as `::ENV`.
 *
 * The env reader turns these into effects, and the defaulted rule asks
 * whether a test elsewhere reads the same variable, so both take the
 * spellings from here.
 */

import { field, readCallArgs, stringLiteralValue } from "./ast.js";

import type { RbNode } from "./parser.js";

/** How the source writes one read, before anything asks whether it has a fallback. */
export interface EnvSpelling {
  readonly name: RbNode;
  /** Whether the read itself supplies a value, as `ENV.fetch("X", d)` does. */
  readonly hasDefault: boolean;
  /** Whether the read raises when the variable is unset, as `ENV.fetch("X")` does. */
  readonly raises: boolean;
}

export function envSpellingAt(node: RbNode): EnvSpelling | null {
  if (node.type === "element_reference") {
    return elementSite(node);
  }
  if (node.type === "call") {
    return fetchSite(node);
  }
  return null;
}

/** Two literals the same string, or two expressions spelled the same way. */
export function isSameName(one: RbNode, other: RbNode): boolean {
  const literal = stringLiteralValue(one);
  if (literal !== null) {
    return literal === stringLiteralValue(other);
  }
  return one.text === other.text;
}

/** `ENV["X"]`, which is nil when the variable is unset. */
function elementSite(node: RbNode): EnvSpelling | null {
  const object = field(node, "object");
  if (object === null || !isEnv(object) || isAssignedTo(node)) {
    return null;
  }
  const index = node.namedChildren.find(
    (child): child is RbNode => child !== null && child.id !== object.id,
  );
  if (index === undefined) {
    return null;
  }
  return { name: index, hasDefault: false, raises: false };
}

/** `ENV.fetch("X")`, which raises when the variable is unset unless a second argument or a block supplies the fallback. */
function fetchSite(node: RbNode): EnvSpelling | null {
  const receiver = field(node, "receiver");
  if (
    receiver === null ||
    !isEnv(receiver) ||
    field(node, "method")?.text !== "fetch"
  ) {
    return null;
  }
  const { positional } = readCallArgs(field(node, "arguments"));
  const name = positional[0];
  if (name === undefined) {
    return null;
  }
  const hasDefault = positional.length > 1 || field(node, "block") !== null;
  return { name, hasDefault, raises: !hasDefault };
}

/** The core `ENV` object, written bare or as `::ENV`. */
export function isEnv(node: RbNode): boolean {
  if (node.type === "constant") {
    return node.text === "ENV";
  }
  return (
    node.type === "scope_resolution" &&
    field(node, "scope") === null &&
    field(node, "name")?.text === "ENV"
  );
}

/** `ENV["X"] = v` changes the environment rather than reading it. */
function isAssignedTo(node: RbNode): boolean {
  const parent = node.parent;
  return (
    parent !== null &&
    (parent.type === "assignment" || parent.type === "operator_assignment") &&
    field(parent, "left")?.id === node.id
  );
}
