/**
 * Which of the findings that moved between two runs a change can have
 * caused, so a review of a pull request reads those and not every
 * finding the repository already had.
 *
 * A finding is in the change when a summary on one of its sides is in a
 * file the change edited, or is a unit whose behavior moved, or when its
 * boundary is one the code changed at. The file test catches what a unit
 * reads off its input, which no transition records. The unit test
 * catches a route that changed because a helper in another file did. The
 * boundary test catches a finding between two unchanged summaries that a
 * third unit's new read or write produced.
 */

import { mergedSideOf } from "../dedupe.js";
import { changesSince, unitsThatMoved } from "./changesSince.js";
import { boundaryKeyOf } from "./findingIdentity.js";

import type { Finding } from "@suss/behavioral-ir";
import type { ChangesSince, CheckedRun } from "./changesSince.js";

/** What a change touched, for testing a finding against it. */
export interface ChangeScope {
  /** Every tail of every changed path, so a summary's file matches by its own path. */
  pathTails: ReadonlySet<string>;
  /** Units that were added, removed or behave differently, as `file::name`. */
  units: ReadonlySet<string>;
  /** Keys of the boundaries the code changed at. */
  boundaries: ReadonlySet<string>;
}

/** The parts of a finding that a change touched. */
export type ChangeTouch = "provider" | "consumer" | "boundary";

export interface ChangesWithin extends ChangesSince {
  /** The changed paths the scope was built from, as given. */
  changedFiles: string[];
  /**
   * New findings that touch nothing in the change. These most often come
   * from reading the two revisions differently, so they are kept apart.
   */
  addedElsewhere: Finding[];
  /** Findings that went away and touched nothing in the change. */
  resolvedElsewhere: Finding[];
  /** What the split tested against, for asking `touchedByChange` which part a finding touched. */
  scope: ChangeScope;
}

/**
 * The paths are relative to the repository or to the project, and a
 * summary's file is relative to the directory it was extracted from, so
 * a summary file matches a changed path that is it or ends with it.
 */
export function changeScope(
  earlier: CheckedRun,
  later: CheckedRun,
  changedFiles: readonly string[],
  changedBoundaryKeys: readonly string[],
): ChangeScope {
  return {
    pathTails: tailsOf(changedFiles),
    units: unitsThatMoved(earlier.summaries, later.summaries),
    boundaries: new Set(changedBoundaryKeys),
  };
}

/** Everything that moved between two runs, with the findings split by whether the change touched them. */
export function changesWithin(
  earlier: CheckedRun,
  later: CheckedRun,
  changedFiles: readonly string[],
): ChangesWithin {
  const since = changesSince(earlier, later);
  const scope = changeScope(
    earlier,
    later,
    changedFiles,
    since.changedBoundaries.map((boundary) => boundary.key),
  );
  const touched = (finding: Finding) =>
    touchedByChange(finding, scope).length > 0;
  return {
    ...since,
    changedFiles: [...changedFiles],
    added: since.added.filter(touched),
    resolved: since.resolved.filter(touched),
    addedElsewhere: since.added.filter((finding) => !touched(finding)),
    resolvedElsewhere: since.resolved.filter((finding) => !touched(finding)),
    scope,
  };
}

/** Which parts of the finding the change touched, empty when it touched none. */
export function touchedByChange(
  finding: Finding,
  scope: ChangeScope,
): ChangeTouch[] {
  const touches: ChangeTouch[] = [];
  const merged = mergedSideOf(finding) ?? "provider";
  for (const side of ["provider", "consumer"] as const) {
    const refs = [
      finding[side].summary,
      ...(side === merged ? (finding.sources ?? []) : []),
    ];
    const files = [finding[side].location.file, ...refs.map(fileOfRef)];
    if (
      refs.some((ref) => scope.units.has(ref)) ||
      files.some((file) => scope.pathTails.has(normalPath(file)))
    ) {
      touches.push(side);
    }
  }

  if (scope.boundaries.has(boundaryKeyOf(finding.boundary))) {
    touches.push("boundary");
  }
  return touches;
}

/** `src/a.ts` and `a.ts` for `src/a.ts`, so a lookup by a shorter path is one set read. */
function tailsOf(paths: readonly string[]): Set<string> {
  const tails = new Set<string>();
  for (const one of paths) {
    const parts = normalPath(one).split("/");
    for (let start = 0; start < parts.length; start++) {
      tails.add(parts.slice(start).join("/"));
    }
  }
  return tails;
}

function normalPath(file: string): string {
  return file.replaceAll("\\", "/").replace(/^\.\//, "");
}

/** A summary ref is `file::name`, and a file path never contains `::`. */
function fileOfRef(ref: string): string {
  const at = ref.indexOf("::");
  return at === -1 ? ref : ref.slice(0, at);
}
