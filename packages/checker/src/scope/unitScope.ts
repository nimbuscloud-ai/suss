// A declared summary speaks for one deployable unit: the environment a
// SAM function runs with, the queue an ECS task drains. Pairing it
// against code needs an answer to "which code runs in this unit", and
// three things can answer, in descending order of how much they know.
//
// The summary itself is the best answer. A pack that discovers a
// handler under a template entry knows the unit it will be deployed as
// and stamps it.
//
// A stamped summary next to it in the same file is the next best. A
// module is deployed whole, so a helper beside a discovered handler
// runs wherever that handler runs. Packs discover the exported handler
// and leave the rest of the module alone, and most of the code that
// reads configuration sits in that rest.
//
// The template's source directory is the last answer. It names one
// directory per unit, and a monorepo service builds every one of its
// functions from the service root, so that directory answers for all of
// them at once.
//
// Whichever of the first two speaks decides, wherever the declaring
// side also names a unit. Where nothing on the code side names one, the
// directory answers as before, so a pack that stamps nothing pairs as
// it always has.

import type { BehavioralSummary, DeployableUnit } from "@suss/behavioral-ir";

/** The unit each file's code is deployed as, where its summaries agree. */
export type UnitsByFile = ReadonlyMap<string, DeployableUnit>;

export interface UnitScope {
  /** The unit the declaring side speaks for, when it names one. */
  unit: DeployableUnit | undefined;
  /** Which files count as in scope when neither side names a unit. */
  fileInScope: (file: string) => boolean;
}

/**
 * Read the deployable unit off every summary that names one and group
 * the answers by file. A file whose summaries name two different units
 * is left out, so it falls back to the directory rather than picking a
 * winner.
 */
export function unitsByFile(summaries: BehavioralSummary[]): UnitsByFile {
  const agreed = new Map<string, DeployableUnit>();
  const disputed = new Set<string>();
  for (const summary of summaries) {
    const unit = summary.identity.deployableUnit;
    if (unit === undefined) {
      continue;
    }
    const file = summary.location.file;
    const seen = agreed.get(file);
    if (seen === undefined) {
      agreed.set(file, unit);
      continue;
    }
    if (!sameUnit(seen, unit)) {
      disputed.add(file);
    }
  }
  for (const file of disputed) {
    agreed.delete(file);
  }
  return agreed;
}

/** Whether this code summary runs inside the scope. */
export function runsIn(
  code: BehavioralSummary,
  scope: UnitScope,
  byFile: UnitsByFile,
): boolean {
  const codeUnit =
    code.identity.deployableUnit ?? byFile.get(code.location.file);
  if (codeUnit !== undefined && scope.unit !== undefined) {
    return sameUnit(codeUnit, scope.unit);
  }
  return scope.fileInScope(code.location.file);
}

/** Whether two units name the same thing to deploy. */
export function sameUnit(a: DeployableUnit, b: DeployableUnit): boolean {
  return (
    a.deploymentTarget === b.deploymentTarget &&
    a.instanceName === b.instanceName
  );
}
