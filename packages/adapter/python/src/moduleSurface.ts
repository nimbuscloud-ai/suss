/**
 * The public exports of each module a project lists in `suss.json`, one
 * `library` unit each, keyed `fn:<module>::<exportName>`.
 *
 * A module's surface is what its public file binds at module scope: a
 * function or class written there, or one imported into it, which is how
 * an `__init__.py` usually re-exports. A class contributes its public
 * methods, and a name starting with an underscore is left out. When
 * `suss.json` does not say which file is public, the root's `__init__.py`
 * is. Each unit is built while the file the function is written in is
 * discovered, so its summary seeds the walk for that function the way a
 * route's does, and a cached run charges the public file to it.
 */

import { moduleExportBinding } from "@suss/behavioral-ir";
import {
  type DeclaredModule,
  MODULE_SURFACE_RECOGNITION,
  moduleOfFile,
  type SettledModule,
  settleModules,
} from "@suss/extractor";
import { noteKeyRead } from "@suss/resolution";

import { field, isFunction, stripDecorators } from "./ast.js";
import { originsOf } from "./facts/resolve.js";
import { libraryUnit } from "./reach/closure.js";

import type { Database } from "@suss/datalog";
import type { RawCodeStructure } from "@suss/extractor";
import type { PyNode } from "./parser.js";
import type { BoundPythonFile } from "./routers.js";
import type { StorageLookup } from "./storage.js";

export function settlePythonModules(
  modules: readonly DeclaredModule[] | undefined,
): SettledModule[] {
  return settleModules(modules, ["__init__.py"]);
}

export interface ModuleSurfaceOptions {
  readonly modules: readonly SettledModule[];
  readonly filesByPath: ReadonlyMap<string, BoundPythonFile>;
  readonly facts: Database;
  readonly storageFor: (file: BoundPythonFile) => StorageLookup | undefined;
}

/** One exported function, where it is written, and the name it is exported under. */
interface SurfaceExport {
  readonly file: BoundPythonFile;
  readonly node: PyNode;
  readonly exportPath: readonly string[];
}

/**
 * The module export units written in `file`. An export is kept only when
 * its file belongs to the same module, since a module's surface is made
 * of its own code, so a file in no module has none.
 */
export function moduleExportUnits(
  file: BoundPythonFile,
  options: ModuleSurfaceOptions,
): RawCodeStructure[] {
  const module = moduleOfFile(options.modules, file.file);
  if (module === undefined) {
    return [];
  }
  const units: RawCodeStructure[] = [];
  for (const publicPath of module.public) {
    const publicFile = options.filesByPath.get(publicPath);
    if (publicFile === undefined) {
      continue;
    }
    noteKeyRead(options.facts, publicPath);
    for (const one of surfaceOf(publicFile, file, options)) {
      const exportName = one.exportPath.join(".");
      units.push(
        libraryUnit(
          {
            file: one.file,
            node: one.node,
            name: exportName,
            exportPath: [...one.exportPath],
          },
          options,
          moduleExportBinding({
            recognition: MODULE_SURFACE_RECOGNITION,
            module: module.name,
            exportName,
          }),
        ),
      );
    }
  }
  return units;
}

/** What `publicFile` exports that is written in `definedIn`. */
function surfaceOf(
  publicFile: BoundPythonFile,
  definedIn: BoundPythonFile,
  options: ModuleSurfaceOptions,
): SurfaceExport[] {
  const found: SurfaceExport[] = [];
  for (const [name, binding] of publicFile.module.moduleScope.bindings) {
    if (name.startsWith("_")) {
      continue;
    }
    const written =
      binding.kind === "functionDef" || binding.kind === "classDef"
        ? { file: publicFile, node: binding.node }
        : importedDefinition(publicFile, name, options);
    if (written === null || written.file !== definedIn) {
      continue;
    }
    found.push(...exportsOf(written.file, written.node, name));
  }
  return found;
}

/** The function or class an imported name comes from, when the project writes it. */
function importedDefinition(
  publicFile: BoundPythonFile,
  name: string,
  options: ModuleSurfaceOptions,
): { file: BoundPythonFile; node: PyNode } | null {
  const binding = publicFile.module.moduleScope.bindings.get(name);
  if (binding?.kind !== "importFrom" && binding?.kind !== "import") {
    return null;
  }
  for (const origin of originsOf(options.facts, `${publicFile.file}#${name}`)) {
    const file = options.filesByPath.get(origin.module);
    const defined = file?.module.moduleScope.bindings.get(origin.name);
    if (
      file !== undefined &&
      (defined?.kind === "functionDef" || defined?.kind === "classDef")
    ) {
      return { file, node: defined.node };
    }
  }
  return null;
}

/** A function is one export, and a class is one per public method. */
function exportsOf(
  file: BoundPythonFile,
  node: PyNode,
  exportName: string,
): SurfaceExport[] {
  if (isFunction(node)) {
    return [{ file, node, exportPath: [exportName] }];
  }
  const body = field(node, "body");
  if (node.type !== "class_definition" || body === null) {
    return [];
  }
  return body.namedChildren.flatMap((child) => {
    if (child === null) {
      return [];
    }
    const method = stripDecorators(child).definition;
    const methodName = field(method, "name")?.text;
    if (
      !isFunction(method) ||
      methodName === undefined ||
      methodName.startsWith("_")
    ) {
      return [];
    }
    return [{ file, node: method, exportPath: [exportName, methodName] }];
  });
}
