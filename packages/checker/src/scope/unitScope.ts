/**
 * A declared summary describes one deployable unit: the environment a
 * SAM function runs with, the queue an ECS task drains. Pairing it
 * against code means working out which code runs in that unit, and
 * three things can tell you, in descending order of how much they know.
 *
 * Best is the summary itself. A pack that discovers a handler under a
 * template entry knows which unit it will be deployed as.
 *
 * Next best are the summaries beside it in the same file. A module is
 * deployed whole, so a helper next to a discovered handler runs
 * wherever that handler runs, and most of the code that reads
 * configuration is in that rest of the module.
 */

/**
 * Last comes the template's source directory, and only when it is the
 * one directory that could contain the file. A monorepo service builds
 * every function from the service root, so that directory covers all of
 * them, and going by it would put every file in every unit at once.
 * Where several directories contain the file, none of them decides.
 */

import { readCodeScopeMetadata, sameUnit } from "@suss/behavioral-ir";
import { fileInCodeScope } from "@suss/ir-core";

import type {
  BehavioralSummary,
  CodeScopeMetadata,
  DeployableUnit,
} from "@suss/behavioral-ir";

export type { CodeScopeMetadata } from "@suss/behavioral-ir";

/** The code scope on a declaring summary, or the unknown marker when it
 * has none. */
export function readCodeScope(summary: BehavioralSummary): CodeScopeMetadata {
  return readCodeScopeMetadata(summary) ?? { kind: "unknown" };
}

/** The units each file's code is deployed as, according to its own
 * summaries. */
export type UnitsByFile = ReadonlyMap<string, DeployableUnit[]>;

export interface UnitScope {
  /** The unit the declaring side describes, when it gives one. */
  unit: DeployableUnit | undefined;
  /** The source directory to fall back on when neither side gives a unit. */
  codeScope: string;
  /**
   * The files the runtime's handler entry reaches through imports.
   * When set, membership decides instead of the directory: a shared
   * helper pairs with every runtime whose closure loads it, and a file
   * outside every closure pairs with none.
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
 * among code that gives no unit of its own. Nothing tells the scopes
 * apart for such a file, so a caller that would otherwise pair it
 * against every one of them pairs it against none and says why.
 *
 * Code that gives a unit is never in here: the units decide, and the
 * directories are not consulted.
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
    // A closure settles membership for its runtime, so a file in two
    // closures is in both runtimes rather than in doubt, and only the
    // scopes with no closure still tell files apart by directory.
    if (scopes.some((s) => s.closure?.has(file) === true)) {
      continue;
    }

    let containing = 0;
    for (const scope of scopes) {
      if (scope.closure !== undefined) {
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
  return fileInCodeScope(code.location.file, scope.codeScope);
}
