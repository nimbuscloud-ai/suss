/**
 * Where an imported name is defined, when the project defines it.
 *
 * The binder resolves a name inside one file only, so `item_in: ItemCreate`
 * with `ItemCreate` imported from a models module comes back as an import
 * binding and nothing more. This asks the resolution rules where the name
 * came from, through any re-exports on the way, and returns the class or
 * the assigned value the defining file binds it to, along with that file's
 * scopes so the definition can be read in the scope it is written in.
 */

import { originsOf } from "./facts/resolve.js";
import { moduleScopeOf } from "./scope.js";

import type { Database } from "@suss/datalog";
import type { PyNode } from "./parser.js";
import type { BoundPythonFile } from "./routers.js";
import type { Binding, Scope } from "./scope.js";

export interface ImportedDefinition {
  /** The class_definition, or the value an assignment gave the name. */
  node: PyNode;
  /** The module scope of the file the definition is written in. */
  moduleScope: Scope;
  /** The scopes of that file, keyed by the node that opens each one. */
  scopeFor: Map<number, Scope>;
}

/** `scope` is where the name is read, which is what keys the import in the facts. */
export type ImportedDefinitionLookup = (
  scope: Scope,
  name: string,
) => ImportedDefinition | null;

export function importedDefinitionLookup(
  db: Database,
  files: readonly BoundPythonFile[],
): ImportedDefinitionLookup {
  const fileOfModuleScope = new Map<number, string>();
  const byFile = new Map<string, BoundPythonFile>();
  for (const file of files) {
    fileOfModuleScope.set(file.module.moduleScope.node.id, file.file);
    byFile.set(file.file, file);
  }
  const found = new Map<string, ImportedDefinition | null>();

  return (scope, name) => {
    const fromFile = fileOfModuleScope.get(moduleScopeOf(scope).node.id);
    if (fromFile === undefined) {
      return null;
    }
    const key = `${fromFile}#${name}`;
    const known = found.get(key);
    if (known !== undefined) {
      return known;
    }
    const definition = definitionAmong(originsOf(db, key), byFile);
    found.set(key, definition);
    return definition;
  };
}

/** The first origin that is a project file binding the name to a class or a value of its own. */
function definitionAmong(
  origins: readonly { module: string; name: string }[],
  byFile: ReadonlyMap<string, BoundPythonFile>,
): ImportedDefinition | null {
  for (const origin of origins) {
    const file = byFile.get(origin.module);
    const binding = file?.module.moduleScope.bindings.get(origin.name);
    if (file === undefined || binding === undefined) {
      continue;
    }
    const node = definedNodeOf(binding);
    if (node !== null) {
      return {
        node,
        moduleScope: file.module.moduleScope,
        scopeFor: file.module.scopeFor,
      };
    }
  }
  return null;
}

function definedNodeOf(binding: Binding): PyNode | null {
  if (binding.kind === "classDef") {
    return binding.node;
  }
  if (binding.kind === "assignment") {
    return binding.value;
  }
  return null;
}
