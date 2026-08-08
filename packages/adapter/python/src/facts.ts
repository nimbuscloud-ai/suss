// facts.ts: what the binder and the module resolver hand to the shared
// fact store.
//
// This is the Layer 1 contract: discover units, emit summaries, emit
// these facts.
//
// `entry` reuses the existing relation name and shape, where the unit
// is a pack-discovered entry point, so a Python-discovered route is an
// entry the same way a TypeScript one is, ready for whatever rule wants
// to join against it later.
//
// `pyImport`, `pyImportResolved` and `pyOpenImport` are the two
// additions Python needs. The first two record repo-scoped module
// resolution as facts, where abstaining comes back as a status with no
// resolved file rather than a guess. The third records `from module
// import *` for a future rule to consult when it needs to, rather than
// expanding it here.

import { resolveModule } from "./moduleResolver.js";

import type { Database } from "@suss/datalog";
import type { ModuleResolverOptions } from "./moduleResolver.js";
import type { ModuleBinding } from "./scope.js";

/**
 * The name is part of the key because the range is measured in lines, two
 * units can start on the same line, and `entry` is a set, so keying on the range
 * alone would drop one of them.
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

/** Module scope only. A function- or class-scoped import is not recorded. */
export function emitModuleImportFacts(
  db: Database,
  filePath: string,
  module: ModuleBinding,
  resolverOptions: ModuleResolverOptions,
): void {
  for (const binding of module.moduleScope.bindings.values()) {
    if (binding.kind !== "import" && binding.kind !== "importFrom") {
      continue;
    }
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
    if (resolution.status === "resolved") {
      db.add("pyImportResolved", [filePath, moduleText, resolution.file]);
    }
  }

  for (const openModule of module.openImports) {
    db.add("pyOpenImport", [filePath, openModule]);
  }
}
