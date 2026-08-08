// facts.ts: what the binder and the module resolver hand to the shared
// fact store, per facts-and-rules.md's Layer 1 contract ("discover
// units, emit summaries, emit these facts").
//
// `entry` reuses the existing relation name and shape (unit is a
// pack-discovered entry point) so a Python-discovered route is an
// entry the same way a TypeScript one is, ready for whatever rule
// wants to join against it later. `pyImport` /
// `pyImportResolved` / `pyOpenImport` are the two additions the
// language-adapters proposal names: repo-scoped module resolution
// recorded as facts (abstaining reads as a status with no resolved
// file, never a guess), and the open-import relation for `from module
// import *`, left for a future rule to consult lazily rather than
// expanded here.

import { resolveModule } from "./moduleResolver.js";

import type { Database } from "@suss/datalog";
import type { ModuleResolverOptions } from "./moduleResolver.js";
import type { ModuleBinding } from "./scope.js";

/**
 * What names one discovered unit for the rest of a run.
 *
 * The name is part of the key because the range is lines, and two
 * units can share a line: `field :id, ID; field :name, String` is one
 * line and two units in Ruby, and Python allows the same with a
 * semicolon. Keying on the range alone made those one key, and the
 * `entry` relation is a set, so the second unit vanished from it. This
 * is the same thing `summaryIdentity.ts` does when two summaries claim
 * one id: what tells them apart is what they are called.
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

/**
 * `module` as it reads for the `pyImport` relation: the dotted path
 * with its leading dots restored for a relative import, matching how
 * a person reading the fact table would recognize the same import if
 * they saw it written in source.
 */
function importedModuleText(module: string, relativeLevel: number): string {
  return relativeLevel > 0 ? `${".".repeat(relativeLevel)}${module}` : module;
}

/**
 * Resolve and record every import bound at module scope. Nested
 * (function- or class-scoped) imports are out of v0: the fixtures and
 * the measured corpus both write route wrapper imports at module
 * level, and a resolver call for an import nobody reads yet is work
 * spent on facts nothing consumes.
 */
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
