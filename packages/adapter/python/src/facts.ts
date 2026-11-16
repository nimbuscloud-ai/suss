/**
 * The facts the module resolver adds to the shared store.
 *
 * `importsModule` records each module a file imports, as written, and
 * `importsFile` the file an import resolved to. An import the resolver
 * abstains on gets no file rather than a guessed one.
 */

import { NAMESPACE_IMPORT_NAME } from "@suss/resolution";

import { resolveModule } from "./moduleResolver.js";

import type { Database } from "@suss/datalog";
import type { ModuleResolverOptions } from "./moduleResolver.js";
import type { Binding, ModuleBinding } from "./scope.js";

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
      db.add("importsModule", [filePath, moduleText]);
      // A module-scope name is one another file can import back out.
      if (scope.kind === "module") {
        db.add("exportsAs", [filePath, localName, nameKey]);
      }
      // `import fastapi` brings in the whole module. The shared rules spell
      // that `*`, and it lets them resolve `fastapi.APIRouter` to fastapi's
      // own `APIRouter`.
      const importedName =
        binding.kind === "import" ? binding.localName : binding.importedName;
      const exportedName =
        binding.kind === "import" && binding.bindsWholeModule
          ? NAMESPACE_IMPORT_NAME
          : importedName;
      // The shared rules follow a name across files through `imports` and
      // `exportsAs`, which key a module by its file.
      if (resolution.status === "resolved") {
        db.add("importsFile", [filePath, resolution.file]);
        db.add("imports", [nameKey, resolution.file, exportedName]);
      }
      // Keyed on the module text for every import, so a pack matching its
      // library tells `FastAPI()` apart from a project class of that name.
      db.add("imports", [nameKey, moduleText, exportedName]);
      if (binding.kind === "importFrom") {
        emitSubmoduleImportFacts(
          db,
          filePath,
          nameKey,
          binding,
          resolverOptions,
        );
      }
    }
  }
  emitWildcardImportFacts(db, filePath, module, resolverOptions);
}

/**
 * `from pkg import mod` gives `mod` the package's own name `mod` when
 * the package binds one, and the submodule `pkg.mod` when it does not.
 * Whenever `pkg.mod` resolves to a file, this states the submodule the
 * way `import pkg.mod as mod` does, beside the package's name. It does
 * not ask whether the package binds `mod`, so when it does, the rules
 * follow both, and the file's module imports list the submodule.
 */
function emitSubmoduleImportFacts(
  db: Database,
  filePath: string,
  nameKey: string,
  binding: Extract<Binding, { kind: "importFrom" }>,
  resolverOptions: ModuleResolverOptions,
): void {
  const submodule = resolveModule(
    filePath,
    {
      module:
        binding.module === ""
          ? binding.importedName
          : `${binding.module}.${binding.importedName}`,
      relativeLevel: binding.relativeLevel,
    },
    resolverOptions,
  );
  if (submodule.status !== "resolved") {
    return;
  }
  db.add("importsFile", [filePath, submodule.file]);
  db.add("imports", [nameKey, submodule.file, NAMESPACE_IMPORT_NAME]);
}

/**
 * A `from x import *` binds every name `x` declares, so another file can
 * import any of them from this one, as a package's `__init__.py` lets it
 * import a class from a module beside it. The shared rules forward them
 * the way they forward TypeScript's `export * from`.
 */
function emitWildcardImportFacts(
  db: Database,
  filePath: string,
  module: ModuleBinding,
  resolverOptions: ModuleResolverOptions,
): void {
  for (const written of module.openImports) {
    const relativeLevel = written.length - written.replace(/^\.+/, "").length;
    const resolution = resolveModule(
      filePath,
      { module: written.slice(relativeLevel), relativeLevel },
      resolverOptions,
    );
    db.add("importsModule", [filePath, written]);
    if (resolution.status === "resolved") {
      db.add("importsFile", [filePath, resolution.file]);
      db.add("reExportsAll", [filePath, resolution.file]);
    }
  }
}
