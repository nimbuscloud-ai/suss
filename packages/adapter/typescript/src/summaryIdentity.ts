/**
 * Naming a summary, so that something else can point at it.
 *
 * A bare function name is not enough. Reading suss's own source turns up
 * 404 summaries that share a name with another one, and a large
 * repository is worse: two services with the same `src/handlers.ts` give
 * every summary in one an exact twin in the other. Following a call by
 * matching names was always a guess about which one was meant.
 *
 * So the name includes the project the summary came from, the file it is
 * in, and the path its export is reached by. That is unique across
 * everything one run can see, and it still looks like something a person
 * would have written down.
 */

import path from "node:path";

import {
  disambiguateSummaryIds,
  linkCallsToSummaries,
  summaryIdFromParts,
} from "@suss/behavioral-ir";

import { namedPackageDirAbove, packageNameAt } from "./packageExports.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

/**
 * The one root a run measures its file paths from: the nearest
 * directory at or above the run's anchor whose package.json has a
 * name. The anchor is the tsconfig's directory, or the directory a
 * run without one was pointed at. When no package.json declares a
 * name above the anchor, the anchor itself is the root.
 *
 * The same directory supplies the workspace segment of an id, so both
 * parts of an id are measured from one place. The walk starts from the
 * run's configuration, not from whichever files the run loaded, so a
 * run over one nested tsconfig spells a file the same way a run over
 * the whole workspace does, and the same command spells it the same
 * way twice.
 */
export function workspaceRootFor(anchor: string): string {
  return namedPackageDirAbove(anchor) ?? path.resolve(anchor);
}

/**
 * What a project calls itself.
 *
 * Its package.json name is what a person would say and what a sibling
 * package already imports it by. A project without one falls back to
 * the folder, which is at least what somebody typed.
 */
export function workspaceNameFor(root: string | undefined): string | null {
  if (root === undefined) {
    return null;
  }
  const dir = namedPackageDirAbove(root);
  if (dir !== null) {
    return packageNameAt(dir);
  }
  const folder = path.basename(path.resolve(root));
  return folder.length > 0 ? folder : null;
}

/**
 * Give every summary a name of its own, and point each call at the
 * summary it reaches.
 *
 * Reads the set as a whole because a call can only be answered by
 * looking at what else came out of the run.
 */
export function nameSummaries(
  summaries: BehavioralSummary[],
  args: { workspace: string | null; projectRoot: string | undefined },
): void {
  for (const summary of summaries) {
    const file = relativeFile(summary.location.file, args.projectRoot);
    if (args.workspace !== null) {
      summary.location.workspace = args.workspace;
    }
    summary.identity.id = idFor(args.workspace, file, summary);
  }

  // One function can produce several summaries, one per thing it
  // consumes, and those share a name, a file and an export path. The
  // boundary each one is about is what tells them apart, and it is also
  // what decides which summaries pair with each other. An anonymous
  // function has no name to start from, so when the boundary does not
  // separate them either, the line number does.
  disambiguateSummaryIds(summaries);

  linkCallsToSummaries(summaries);
}

/** Relative to the project, so the id survives moving the checkout. */
function relativeFile(file: string, projectRoot: string | undefined): string {
  if (projectRoot === undefined || !path.isAbsolute(file)) {
    return file;
  }
  const relative = path.relative(projectRoot, file);
  return relative.startsWith("..") ? file : relative;
}

function idFor(
  workspace: string | null,
  file: string,
  summary: BehavioralSummary,
): string {
  return summaryIdFromParts({
    workspace: workspace ?? undefined,
    file,
    name: summary.identity.name,
    exportPath: summary.identity.exportPath,
  });
}
