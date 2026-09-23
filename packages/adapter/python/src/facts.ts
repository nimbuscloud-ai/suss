/**
 * The facts the binder and the module resolver add to the shared store.
 *
 * A discovered route goes into `entry`, the same relation a TypeScript
 * entry point goes into, so a rule joining on entries sees both.
 *
 * The `py` relations are specific to Python. `pyImport` and
 * `pyImportResolved` record how each import resolved, and an import the
 * resolver abstains on gets its reason as the status instead of a guessed
 * file. `pyOpenImport` records each `from module import *` as written,
 * and nothing expands it here.
 */

import { NAMESPACE_IMPORT_NAME } from "@suss/resolution";

import { resolveModule } from "./moduleResolver.js";

import type { Database } from "@suss/datalog";
import type { ModuleResolverOptions } from "./moduleResolver.js";
import type { ModuleBinding } from "./scope.js";

/**
 * The range is in lines and two units can start on the same line. `entry`
 * is a set, so a key without the name would drop one of the two.
 */
export function unitKey(
  filePath: string,
  range: { start: number; end: number },
  name: string,
): string {
  return `${filePath}:${range.start}-${range.end}#${name}`;
}

export function emitEntryFact(
  db: Database,
  filePath: string,
  range: { start: number; end: number },
  name: string,
): void {
  db.add("entry", [unitKey(filePath, range, name)]);
}

/** The dotted path with its leading dots put back, the way the import is written in the source. */
function importedModuleText(module: string, relativeLevel: number): string {
  return relativeLevel > 0 ? `${".".repeat(relativeLevel)}${module}` : module;
}

/**
 * Every import in the file, wherever it is written. Python code puts an import
 * inside a function to break a cycle between two modules, and a chain through
 * one of those functions stops dead without it.
 */
export function emitModuleImportFacts(
  db: Database,
  filePath: string,
  module: ModuleBinding,
  resolverOptions: ModuleResolverOptions,
): void {
  for (const scope of module.scopeFor.values()) {
    for (const [localName, binding] of scope.bindings) {
      if (binding.kind !== "import" && binding.kind !== "importFrom") {
        continue;
      }
      const nameKey = `${filePath}#${localName}`;
      const moduleText = importedModuleText(
        binding.module,
        binding.relativeLevel,
      );
      const resolution = resolveModule(
        filePath,
        { module: binding.module, relativeLevel: binding.relativeLevel },
        resolverOptions,
      );
      db.add("pyImport", [
        filePath,
        moduleText,
        resolution.status === "resolved" ? "resolved" : resolution.reason,
      ]);
      const importedName =
        binding.kind === "import" ? binding.localName : binding.importedName;
      // Recorded for every import so a name from a library outside the run
      // still says which module it came from.
      db.add("pyImportedName", [nameKey, moduleText, importedName]);
      // A module-scope name is one another file can import back out.
      if (scope.kind === "module") {
        db.add("exportsAs", [filePath, localName, nameKey]);
      }
      // `import fastapi` brings in the whole module. The shared rules spell
      // that `*`, and it lets them resolve `fastapi.APIRouter` to fastapi's
      // own `APIRouter`.
      const exportedName =
        binding.kind === "import" && binding.bindsWholeModule
          ? NAMESPACE_IMPORT_NAME
          : importedName;
      if (resolution.status === "resolved") {
        db.add("pyImportResolved", [filePath, moduleText, resolution.file]);
        // The shared rules follow a name across files through `imports` and
        // `exportsAs`, so a resolved module is keyed by its file.
        db.add("imports", [nameKey, resolution.file, exportedName]);
        continue;
      }
      // A third-party package resolves to no file. Keying the import on the
      // module text still tells `FastAPI()` apart from a constructor of the
      // same name that the project wrote itself.
      db.add("imports", [nameKey, moduleText, exportedName]);
    }
  }

  for (const openModule of module.openImports) {
    db.add("pyOpenImport", [filePath, openModule]);
  }
}
