/**
 * envReads.ts: the environment variables a body reads through the core
 * `ENV` object. `ENV["X"]`, `ENV.fetch("X", d)` and `ENV.fetch("X") { d }`
 * become the config-read effect the TypeScript adapter emits for
 * `process.env.X`, with the same defaulted flag, so the runtime-config
 * checker pairs them against a template the same way.
 *
 * `ENV` is the language's own object, so this belongs to the adapter and
 * not to a pack. A read whose name is not a string literal is skipped,
 * the way the TypeScript reader skips `process.env[name]`. The README
 * lists every spelling that is and is not read.
 */

import { runtimeConfigBinding } from "@suss/behavioral-ir";
import { SKIP_CHILDREN, walkDescendants } from "@suss/extractor";

import { field, readCallArgs, stringLiteralValue } from "./ast.js";

import type { Effect } from "@suss/behavioral-ir";
import type { RbNode } from "./parser.js";

export const RUBY_ENV_RECOGNITION = "ruby-env";

interface EnvRead {
  name: string;
  defaulted: boolean;
}

/** A method or lambda body runs when it is called, so its reads wait for its own unit. */
const DEFERRED_BODY_TYPES = new Set(["method", "singleton_method", "lambda"]);

/**
 * The config-read effects for every environment read under `root`,
 * in source order. `root` itself is not read: pass a method for its
 * body, or the program node for what runs when the file loads.
 */
export function envReadEffects(root: RbNode): Effect[] {
  const effects: Effect[] = [];
  walkDescendants<RbNode, null>(root, null, {
    at: (node) => {
      const read = envReadAt(node);
      if (read !== null) {
        effects.push(configReadEffect(read));
      }
    },
    into: (node) => (DEFERRED_BODY_TYPES.has(node.type) ? SKIP_CHILDREN : null),
  });
  return effects;
}

function configReadEffect(read: EnvRead): Effect {
  return {
    type: "interaction",
    binding: runtimeConfigBinding({
      recognition: RUBY_ENV_RECOGNITION,
      deploymentTarget: "lambda",
      instanceName: "<unknown>",
    }),
    callee: `ENV["${read.name}"]`,
    interaction: {
      class: "config-read",
      name: read.name,
      defaulted: read.defaulted,
    },
  };
}

function envReadAt(node: RbNode): EnvRead | null {
  if (node.type === "element_reference") {
    return elementRead(node);
  }
  if (node.type === "call") {
    return fetchRead(node);
  }
  return null;
}

/** `ENV["X"]`, which is nil when the variable is unset unless an `||` supplies a fallback. */
function elementRead(node: RbNode): EnvRead | null {
  const object = field(node, "object");
  if (object === null || !isEnv(object) || isAssignedTo(node)) {
    return null;
  }
  const index = node.namedChildren.find(
    (child): child is RbNode => child !== null && child.id !== object.id,
  );
  const name = index === undefined ? null : stringLiteralValue(index);
  if (name === null) {
    return null;
  }
  return { name, defaulted: isDefaultedAt(node) };
}

/** `ENV.fetch("X")`, defaulted when a second argument or a block supplies the fallback. */
function fetchRead(node: RbNode): EnvRead | null {
  const receiver = field(node, "receiver");
  if (
    receiver === null ||
    !isEnv(receiver) ||
    field(node, "method")?.text !== "fetch"
  ) {
    return null;
  }
  const { positional } = readCallArgs(field(node, "arguments"));
  const name =
    positional[0] === undefined ? null : stringLiteralValue(positional[0]);
  if (name === null) {
    return null;
  }
  const hasDefault = positional.length > 1 || field(node, "block") !== null;
  return { name, defaulted: hasDefault || isDefaultedAt(node) };
}

/** The core `ENV` object, written bare or as `::ENV`. */
function isEnv(node: RbNode): boolean {
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

/**
 * Whether an `||` supplies a value when this read comes back nil. The
 * climb continues through a chain, so B in `A || B || "d"` counts, and
 * stops where the read is the final operand and is itself the fallback.
 */
function isDefaultedAt(node: RbNode): boolean {
  let child = node;
  let parent = node.parent;
  while (parent !== null) {
    if (parent.type === "parenthesized_statements") {
      child = parent;
      parent = parent.parent;
      continue;
    }
    if (parent.type !== "binary" || field(parent, "operator")?.text !== "||") {
      return false;
    }
    if (field(parent, "left")?.id === child.id) {
      return true;
    }
    child = parent;
    parent = parent.parent;
  }
  return false;
}
