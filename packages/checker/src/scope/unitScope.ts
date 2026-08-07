// A declared summary speaks for one deployable unit: the environment a
// SAM function runs with, the queue an ECS task drains. Pairing it
// against code needs an answer to "which code runs in this unit", and
// three things can answer, in descending order of how much they know.
//
// The summary itself is the best answer. A pack that discovers a
// handler under a template entry knows the unit it will be deployed as
// and stamps it.
//
// The stamped summaries next to it in the same file are the next best.
// A module is deployed whole, so a helper beside a discovered handler
// runs wherever that handler runs, and wherever a second handler in the
// module runs too. Packs discover the exported handler and leave the
// rest of the module alone, and most of the code that reads
// configuration sits in that rest.
//
// The template's source directory is the last answer, and it answers
// only when it is the only directory that could. A monorepo service
// builds every one of its functions from the service root, so one
// directory covers all of them, and taking it as the answer would put
// every file in every unit at once.
//
// Whichever of the first two speaks decides, wherever the declaring
// side also names a unit. Where nothing on the code side names one, the
// directory answers, unless several directories contain the file, in
// which case none of them does.

import { fileInCodeScope } from "@suss/ir-core";

import type { BehavioralSummary, DeployableUnit } from "@suss/behavioral-ir";

export interface CodeScopeMetadata {
  kind: "codeUri" | "unknown";
  path?: string;
}

/** The code scope a declaring summary carries, or the unknown marker when it names none. */
export function readCodeScope(summary: BehavioralSummary): CodeScopeMetadata {
  const raw = (summary.metadata?.codeScope ?? null) as CodeScopeMetadata | null;
  if (raw === null) {
    return { kind: "unknown" };
  }

  return raw;
}

/** The units each file's code is deployed as, as its summaries name them. */
export type UnitsByFile = ReadonlyMap<string, DeployableUnit[]>;

export interface UnitScope {
  /** The unit the declaring side speaks for, when it names one. */
  unit: DeployableUnit | undefined;
  /** The source directory that answers when neither side names a unit. */
  codeScope: string;
}

/**
 * Read the deployable unit off every summary that names one and group
 * the answers by file. A module holding two handlers is deployed as
 * both, so the file keeps both units and its helpers run in each.
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
 * The files two or more of these scopes' directories contain, among
 * code that names no unit of its own. Nothing distinguishes the scopes
 * for such a file, so a caller that would otherwise pair it against
 * every one of them pairs it against none and says why.
 *
 * Code that names a unit is never in here: the two units decide, and
 * the directories are not consulted.
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
    let containing = 0;
    for (const scope of scopes) {
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
  return fileInCodeScope(code.location.file, scope.codeScope);
}

/** Whether two units name the same thing to deploy. */
export function sameUnit(a: DeployableUnit, b: DeployableUnit): boolean {
  return (
    a.deploymentTarget === b.deploymentTarget &&
    a.instanceName === b.instanceName
  );
}
