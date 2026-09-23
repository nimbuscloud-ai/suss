/**
 * The ways Python source writes a read of one environment variable.
 * `os.environ["X"]`, `os.environ.get("X", d)` and `os.getenv("X", d)`
 * all read `X`, through whatever name the file imported `os`, `environ`
 * or `getenv` under.
 *
 * The env reader turns these reads into effects, and the defaulted rule
 * looks for a test elsewhere that reads the same variable. Both use the
 * spellings here so they agree on what counts as a read.
 */

import { field, stringLiteralValue } from "./ast.js";
import { callArguments } from "./facts/values.js";
import { resolveName } from "./scope.js";

import type { PyNode } from "./parser.js";
import type { Scope } from "./scope.js";

/** How the source writes one read, before anything asks whether it has a fallback. */
export interface EnvReadSpelling {
  name: PyNode;
  /** Whether the read itself supplies a value, as `.get("X", d)` does. */
  hasDefault: boolean;
  /** Whether the read raises when the variable is unset, as `os.environ["X"]` does. */
  raises: boolean;
}

export function envReadSpellingAt(
  node: PyNode,
  scope: Scope,
): EnvReadSpelling | null {
  if (node.type === "subscript") {
    return subscriptRead(node, scope);
  }
  if (node.type === "call") {
    return callRead(node, scope);
  }
  return null;
}

/** Two literals the same string, or two expressions spelled the same way. */
export function isSameName(one: PyNode, other: PyNode): boolean {
  const literal = stringLiteralValue(one);
  if (literal !== null) {
    return literal === stringLiteralValue(other);
  }
  return one.text === other.text;
}

/** `os.environ["X"]`, which raises when the variable is unset. */
function subscriptRead(node: PyNode, scope: Scope): EnvReadSpelling | null {
  const value = field(node, "value");
  const index = field(node, "subscript");
  if (value === null || index === null || !isEnviron(value, scope)) {
    return null;
  }
  if (isAssignedTo(node)) {
    return null;
  }
  return { name: index, hasDefault: false, raises: true };
}

/** `os.environ["X"] = v` and `del os.environ["X"]` change the environment rather than read it. */
function isAssignedTo(node: PyNode): boolean {
  const parent = node.parent;
  if (parent === null) {
    return false;
  }
  if (parent.type === "delete_statement") {
    return true;
  }
  return (
    (parent.type === "assignment" || parent.type === "augmented_assignment") &&
    field(parent, "left")?.id === node.id
  );
}

/** `os.environ.get("X", d)` and `os.getenv("X", d)`, defaulted when a second argument is passed. */
function callRead(node: PyNode, scope: Scope): EnvReadSpelling | null {
  const callee = field(node, "function");
  if (callee === null || !isEnvGetter(callee, scope)) {
    return null;
  }
  const written = callArguments(node);
  const name = written.find(
    (argument) => argument.kind === "positional" && argument.position === 0,
  );
  if (name === undefined) {
    return null;
  }
  const hasDefault = written.some(
    (argument) =>
      (argument.kind === "positional" && argument.position === 1) ||
      (argument.kind === "keyword" && argument.name === "default"),
  );
  return { name: name.node, hasDefault, raises: false };
}

/** `os.environ.get` or `os.getenv`, through whatever name the file imported them under. */
function isEnvGetter(callee: PyNode, scope: Scope): boolean {
  if (callee.type === "attribute") {
    const object = field(callee, "object");
    const attribute = field(callee, "attribute")?.text;
    if (object === null) {
      return false;
    }
    if (attribute === "get") {
      return isEnviron(object, scope);
    }
    return attribute === "getenv" && isOsModule(object, scope);
  }
  return isImportedFromOs(callee, scope, "getenv");
}

/** `os.environ`, or `environ` after `from os import environ`. */
export function isEnviron(node: PyNode, scope: Scope): boolean {
  if (node.type === "attribute") {
    const object = field(node, "object");
    return (
      object !== null &&
      field(node, "attribute")?.text === "environ" &&
      isOsModule(object, scope)
    );
  }
  return isImportedFromOs(node, scope, "environ");
}

function isOsModule(node: PyNode, scope: Scope): boolean {
  if (node.type !== "identifier") {
    return false;
  }
  const binding = resolveName(scope, node.text);
  return (
    binding?.kind === "import" &&
    binding.module === "os" &&
    binding.relativeLevel === 0
  );
}

function isImportedFromOs(node: PyNode, scope: Scope, name: string): boolean {
  if (node.type !== "identifier") {
    return false;
  }
  const binding = resolveName(scope, node.text);
  return (
    binding?.kind === "importFrom" &&
    binding.module === "os" &&
    binding.relativeLevel === 0 &&
    binding.importedName === name
  );
}
