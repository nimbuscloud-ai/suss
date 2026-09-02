/**
 * envReads.ts: the environment variables a body reads through the
 * standard library. `os.environ["X"]`, `os.environ.get("X", d)` and
 * `os.getenv("X", d)` become the config-read effect the TypeScript
 * adapter emits for `process.env.X`, with the same defaulted flag, so
 * the runtime-config checker pairs them against a template the same way.
 *
 * `os` is the language's own module, so this belongs to the adapter and
 * not to a pack. A read whose name is not a string literal is skipped,
 * the way the TypeScript reader skips `process.env[name]`. The README
 * lists every spelling that is and is not read.
 */

import { runtimeConfigBinding } from "@suss/behavioral-ir";
import { SKIP_CHILDREN, walkDescendants } from "@suss/extractor";

import { field, stringLiteralValue } from "./ast.js";
import { resolveName } from "./scope.js";

import type { Effect } from "@suss/behavioral-ir";
import type { PyNode } from "./parser.js";
import type { ModuleBinding, Scope } from "./scope.js";

export const PYTHON_ENV_RECOGNITION = "python-env";

interface EnvRead {
  name: string;
  defaulted: boolean;
}

/** A nested function's reads happen when it is called, so its body waits for its own unit. */
const DEFERRED_BODY_TYPES = new Set(["function_definition", "lambda"]);

/**
 * The config-read effects for every environment read under `root`,
 * in source order. `root` itself is not read: pass the unit's function
 * for its body, or the module node for what runs at import time.
 */
export function envReadEffects(root: PyNode, module: ModuleBinding): Effect[] {
  const effects: Effect[] = [];
  const startScope = module.scopeFor.get(root.id) ?? module.moduleScope;
  walkDescendants<PyNode, Scope>(root, startScope, {
    at: (node, scope) => {
      const read = envReadAt(node, scope);
      if (read !== null) {
        effects.push(configReadEffect(read));
      }
    },
    into: (node, scope) => {
      if (DEFERRED_BODY_TYPES.has(node.type)) {
        return SKIP_CHILDREN;
      }
      return module.scopeFor.get(node.id) ?? scope;
    },
  });
  return effects;
}

function configReadEffect(read: EnvRead): Effect {
  return {
    type: "interaction",
    binding: runtimeConfigBinding({
      recognition: PYTHON_ENV_RECOGNITION,
      deploymentTarget: "lambda",
      instanceName: "<unknown>",
    }),
    callee: `os.environ["${read.name}"]`,
    interaction: {
      class: "config-read",
      name: read.name,
      defaulted: read.defaulted,
    },
  };
}

function envReadAt(node: PyNode, scope: Scope): EnvRead | null {
  if (node.type === "subscript") {
    return subscriptRead(node, scope);
  }
  if (node.type === "call") {
    return callRead(node, scope);
  }
  return null;
}

/** `os.environ["X"]`, which raises when the variable is unset unless an `or` supplies a fallback. */
function subscriptRead(node: PyNode, scope: Scope): EnvRead | null {
  const value = field(node, "value");
  const index = field(node, "subscript");
  if (value === null || index === null || !isEnviron(value, scope)) {
    return null;
  }
  const name = stringLiteralValue(index);
  if (name === null || isAssignedTo(node)) {
    return null;
  }
  return { name, defaulted: isDefaultedAt(node) };
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
function callRead(node: PyNode, scope: Scope): EnvRead | null {
  const callee = field(node, "function");
  const args = field(node, "arguments");
  if (callee === null || args === null || !isEnvGetter(callee, scope)) {
    return null;
  }
  const positional = args.namedChildren.filter(
    (arg): arg is PyNode => arg !== null && arg.type !== "keyword_argument",
  );
  const name =
    positional[0] === undefined ? null : stringLiteralValue(positional[0]);
  if (name === null) {
    return null;
  }
  const keywords = args.namedChildren.filter(
    (arg): arg is PyNode => arg !== null && arg.type === "keyword_argument",
  );
  const hasDefault =
    positional.length > 1 ||
    keywords.some((arg) => field(arg, "name")?.text === "default");
  return { name, defaulted: hasDefault || isDefaultedAt(node) };
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
function isEnviron(node: PyNode, scope: Scope): boolean {
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

/**
 * Whether an `or` supplies a value when this read comes back empty. The
 * climb continues through a chain, so B in `A or B or "d"` counts, and
 * stops where the read is the final operand and is itself the fallback.
 */
function isDefaultedAt(node: PyNode): boolean {
  let child = node;
  let parent = node.parent;
  while (parent !== null) {
    if (parent.type === "parenthesized_expression") {
      child = parent;
      parent = parent.parent;
      continue;
    }
    if (
      parent.type !== "boolean_operator" ||
      field(parent, "operator")?.text !== "or"
    ) {
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
