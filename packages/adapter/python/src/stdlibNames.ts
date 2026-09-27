/**
 * Whether a name in a body is the standard library's own: a module the
 * file imported, or a builtin nothing in scope rebinds. The readers of
 * what a body prints, how it exits and which flags it parses all ask.
 */

import { resolveName } from "./scope.js";

import type { PyNode } from "./parser.js";
import type { Scope } from "./scope.js";

/** A name the file bound with `import <module>`. */
export function isStdlibModule(
  node: PyNode,
  scope: Scope,
  module: string,
): boolean {
  if (node.type !== "identifier") {
    return false;
  }
  const binding = resolveName(scope, node.text);
  return (
    binding?.kind === "import" &&
    binding.module === module &&
    binding.relativeLevel === 0
  );
}

/** A name nothing in scope rebinds, so it is the builtin of that name. */
export function isBuiltin(node: PyNode, scope: Scope, name: string): boolean {
  return (
    node.type === "identifier" &&
    node.text === name &&
    resolveName(scope, name) === null
  );
}

/** `module.name`, or `name` after `from module import name`. */
export function isStdlibMember(
  node: PyNode,
  scope: Scope,
  module: string,
  name: string,
): boolean {
  if (node.type === "attribute") {
    const object = node.childForFieldName("object");
    return (
      node.childForFieldName("attribute")?.text === name &&
      object !== null &&
      isStdlibModule(object, scope, module)
    );
  }
  if (node.type !== "identifier" || node.text !== name) {
    return false;
  }
  const binding = resolveName(scope, name);
  return (
    binding?.kind === "importFrom" &&
    binding.module === module &&
    binding.relativeLevel === 0 &&
    binding.importedName === name
  );
}
