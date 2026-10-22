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
  fileReference,
  linkCallsToSummaries,
  readSourceDocumentMetadata,
  summaryIdFromParts,
  withSourceDocumentMetadata,
} from "@suss/behavioral-ir";
import {
  namedPackageDirAbove,
  pathInProject,
  projectNameOf,
} from "@suss/behavioral-ir/files";

import { findNearestTsconfig } from "./bootstrap/noTsconfigProject.js";

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
  return root === undefined ? null : projectNameOf(root);
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
    spellPathNames(summary, args.projectRoot);
    const place = placeInRun(summary.location.file, args);
    if (place.workspace !== null) {
      summary.location.workspace = place.workspace;
    }
    summary.identity.id = idFor(place.workspace, place.file, summary);
  }

  // One function can produce several summaries, one per thing it
  // consumes, and those share a name, a file and an export path. The
  // boundary each one is about is what tells them apart, and it is also
  // what decides which summaries pair with each other. An anonymous
  // function has no name to start from, so when the boundary does not
  // separate them either, their order in the file does.
  disambiguateSummaryIds(summaries);

  linkCallsToSummaries(summaries);
}

/** A file as a summary records it: the project it is in, and its path from that project's root. */
export interface FilePlace {
  /** Absolute. */
  root: string;
  workspace: string | null;
  file: string;
}

/**
 * Where a file belongs when it is read as part of its own project: the
 * root an extract of that project measures from, the project's name, and
 * the file's path from that root.
 */
export function projectPlaceOf(file: string): FilePlace {
  const dir = path.dirname(file);
  const tsconfig = findNearestTsconfig(dir);
  const root = workspaceRootFor(
    tsconfig === null ? dir : path.dirname(tsconfig),
  );
  return {
    root,
    workspace: workspaceNameFor(root),
    file: pathInProject(file, root),
  };
}

/**
 * Where a file outside the run's root belongs, such as a sibling package
 * reached through a workspace link, or null for a file under the root.
 * The path the link leads to never appears, so every checkout agrees.
 */
export function placeOutsideRun(
  file: string,
  runRoot: string,
): FilePlace | null {
  const inRun = path.relative(runRoot, file);
  if (!inRun.startsWith("..") && !path.isAbsolute(inRun)) {
    return null;
  }
  return projectPlaceOf(file);
}

/**
 * How a summary writes a path on disk that it mentions, such as an
 * import: its path from the run's root, or the other project's name and
 * the path from that project's root for a file outside the run.
 */
export function pathFromRun(file: string, runRoot: string): string {
  if (!path.isAbsolute(file)) {
    return file;
  }
  const outside = placeOutsideRun(file, runRoot);
  return outside === null
    ? pathInProject(file, runRoot)
    : fileReference(outside.workspace, outside.file);
}

function placeInRun(
  file: string,
  args: { workspace: string | null; projectRoot: string | undefined },
): { workspace: string | null; file: string } {
  if (args.projectRoot === undefined || !path.isAbsolute(file)) {
    return { workspace: args.workspace, file };
  }
  return (
    placeOutsideRun(file, args.projectRoot) ?? {
      workspace: args.workspace,
      file: pathInProject(file, args.projectRoot),
    }
  );
}

/**
 * A name that is a path on disk, such as the file a schema document is
 * named after, is spelled like any other path, so the id built from it
 * is the same on every machine.
 */
function spellPathNames(
  summary: BehavioralSummary,
  projectRoot: string | undefined,
): void {
  if (projectRoot === undefined) {
    return;
  }
  if (path.isAbsolute(summary.identity.name)) {
    summary.identity.name = pathFromRun(summary.identity.name, projectRoot);
  }
  const label = readSourceDocumentMetadata(summary)?.label;
  if (label !== undefined && path.isAbsolute(label)) {
    summary.metadata = withSourceDocumentMetadata(summary.metadata, {
      label: pathFromRun(label, projectRoot),
    });
  }
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
