/**
 * Which code runs in a declared deployable unit, such as the
 * environment a SAM function runs with. Three sources answer that, from
 * most to least reliable.
 *
 * 1. The code summary's own `deployableUnit`, set by a pack that found
 *    the handler under a template entry.
 * 2. The other summaries in the same file. A module is deployed whole,
 *    so its helpers run wherever its handler runs.
 * 3. The template's source directory, only when it is the one directory
 *    that contains the file. A monorepo service builds every function
 *    from the service root, and that directory would put every file in
 *    every unit.
 */

import { fileInCodeScope } from "@suss/ir-core";

import { sameUnit } from "../declaredDelivery.js";
import { readCodeScopeMetadata } from "../metadata.js";

import type { BehavioralSummary, DeployableUnit } from "../index.js";
import type { CodeScopeMetadata } from "../metadata.js";

export type { CodeScopeMetadata } from "../metadata.js";

/** The code scope on a declaring summary, or `{ kind: "unknown" }` when it has none. */
export function readCodeScope(summary: BehavioralSummary): CodeScopeMetadata {
  return readCodeScopeMetadata(summary) ?? { kind: "unknown" };
}

/** The units each file's code is deployed as, according to its own summaries. */
export type UnitsByFile = ReadonlyMap<string, DeployableUnit[]>;

export interface UnitScope {
  /** The unit the declaring side describes, when it gives one. */
  unit: DeployableUnit | undefined;
  /**
   * The source directory to fall back on when neither side gives a
   * unit. Absent when nothing gave one, as with a Terraform
   * configuration, and then only the closure places a file.
   */
  codeScope?: string;
  /**
   * The files the runtime's handler entry reaches through imports.
   * When set, it replaces the directory test: a shared helper pairs
   * with every runtime whose closure loads it, and a file outside every
   * closure pairs with none.
   */
  closure?: ReadonlySet<string>;
}

/**
 * Read the deployable unit off every summary that has one and group the
 * results by file. A module with two handlers is deployed as both, so
 * the file keeps both units and its helpers run in each.
 */
export function unitsByFile(summaries: BehavioralSummary[]): UnitsByFile {
  const byFile = new Map<string, DeployableUnit[]>();
  for (const summary of summaries) {
    const unit = summary.identity.deployableUnit;
    if (unit === undefined) {
      continue;
    }
    const file = summary.location.file;
    const units = byFile.get(file) ?? [];
    if (!units.some((seen) => sameUnit(seen, unit))) {
      units.push(unit);
    }
    byFile.set(file, units);
  }
  return byFile;
}

/**
 * The files that two or more of these scopes' directories contain,
 * among code that does not give a unit of its own. The scopes cannot be
 * told apart for such a file, so a caller pairs it against none of them
 * and reports why, instead of pairing it against all of them.
 *
 * Code that gives a unit is never in the set, since its unit places it
 * and the directories are not checked.
 */
export function contestedFiles(
  code: readonly BehavioralSummary[],
  scopes: readonly UnitScope[],
  byFile: UnitsByFile,
): ReadonlySet<string> {
  const unplaced = new Set<string>();
  for (const summary of code) {
    const file = summary.location.file;
    if (summary.identity.deployableUnit !== undefined || byFile.has(file)) {
      continue;
    }
    unplaced.add(file);
  }

  const contested = new Set<string>();
  for (const file of unplaced) {
    // A file inside any closure is placed by that closure, even when it
    // is in two of them. Only scopes without a closure go by directory.
    if (scopes.some((s) => s.closure?.has(file) === true)) {
      continue;
    }

    let containing = 0;
    for (const scope of scopes) {
      if (scope.closure !== undefined || scope.codeScope === undefined) {
        continue;
      }

      if (!fileInCodeScope(file, scope.codeScope)) {
        continue;
      }
      containing += 1;
      if (containing > 1) {
        contested.add(file);
        break;
      }
    }
  }
  return contested;
}

/** Whether this code summary runs inside the scope. */
export function runsIn(
  code: BehavioralSummary,
  scope: UnitScope,
  byFile: UnitsByFile,
): boolean {
  const own = code.identity.deployableUnit;
  const codeUnits = own !== undefined ? [own] : byFile.get(code.location.file);
  const declared = scope.unit;
  if (codeUnits !== undefined && declared !== undefined) {
    return codeUnits.some((unit) => sameUnit(unit, declared));
  }

  if (scope.closure !== undefined) {
    return scope.closure.has(code.location.file);
  }
  // With no directory, nothing places this file. `placeDeclared` never
  // builds a scope with neither a closure nor a directory.
  return (
    scope.codeScope !== undefined &&
    fileInCodeScope(code.location.file, scope.codeScope)
  );
}
