/**
 * Where a callee was imported from, read off the file's scope binding.
 * A callee row in the value tables matches on this origin, so a project
 * function spelled `join` does not match the `os.path` row.
 */

import { field } from "../ast.js";
import { resolveName } from "../scope.js";
import { peelValue } from "./lowering.js";

import type { Origin } from "@suss/values";
import type { PyNode } from "../parser.js";
import type { Binding, ModuleBinding, Scope } from "../scope.js";

/**
 * A dotted callee on an imported module, `os.path.join`, is the module
 * with the middle names appended. A bare name nothing in the file
 * declares is a builtin.
 */
export function originOf(callee: PyNode, module: ModuleBinding): Origin | null {
  const chain = memberChainOf(callee);
  if (chain === null) {
    return null;
  }
  const [rootName, ...rest] = chain;
  if (rootName === undefined) {
    return null;
  }
  const binding = resolveName(scopeAt(callee, module), rootName);
  if (binding === null) {
    return rest.length === 0 ? { module: "builtins", name: rootName } : null;
  }
  const path = importedPathOf(binding, rootName);
  if (path === null) {
    return null;
  }
  const dotted = [...path, ...rest];
  const name = dotted.pop();
  if (name === undefined || dotted.length === 0) {
    return null;
  }
  return { module: dotted.join("."), name };
}

/**
 * The dotted path a local name is imported as: `from os import path`
 * gives `os.path`, `import os` gives `os`, and `import os.path` without
 * an alias binds `os` alone.
 */
function importedPathOf(binding: Binding, localName: string): string[] | null {
  if (binding.kind === "importFrom") {
    if (binding.relativeLevel > 0) {
      return null;
    }
    return [...binding.module.split("."), binding.importedName];
  }
  if (binding.kind !== "import") {
    return null;
  }
  const unaliasedDotted =
    binding.module !== localName && binding.module.startsWith(`${localName}.`);
  return unaliasedDotted ? [localName] : binding.module.split(".");
}

/** `a.b.c` as the names read off it, in order, or null when it does not start at a name. */
function memberChainOf(node: PyNode): string[] | null {
  const names: string[] = [];
  let current = peelValue(node);
  while (current.type === "attribute") {
    const object = field(current, "object");
    const attribute = field(current, "attribute");
    if (object === null || attribute === null) {
      return null;
    }
    names.unshift(attribute.text);
    current = peelValue(object);
  }
  if (current.type !== "identifier") {
    return null;
  }
  return [current.text, ...names];
}

function scopeAt(node: PyNode, module: ModuleBinding): Scope {
  let current: PyNode | null = node;
  while (current !== null) {
    const scope = module.scopeFor.get(current.id);
    if (scope !== undefined) {
      return scope;
    }
    current = current.parent;
  }
  return module.moduleScope;
}
