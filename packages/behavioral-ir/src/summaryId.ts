/**
 * How a summary's id is built from its own fields.
 *
 * The TypeScript adapter's `nameSummaries` settles collisions across a
 * whole run before it assigns ids, which needs every summary in the
 * run. A producer that sees one file at a time, such as a contract
 * reader or the legacy-artifact backfill, has no run to settle against,
 * so it uses the same base formula without the settling. Both call
 * these functions, so the formula has one definition.
 */

import { boundaryKey } from "@suss/ir-core";

import type { BehavioralSummary } from "./index.js";

export interface SummaryIdParts {
  /** The project's own name for itself, when it has one. */
  workspace: string | undefined;
  /** The file the summary is in, in whatever form the caller uses. */
  file: string;
  name: string;
  exportPath: string[] | null;
}

/**
 * Extend only the ids that more than one summary ended up with, so an id
 * without a collision stays short. The boundary key tells same-named
 * summaries apart first, and the order in the file settles the rest: the
 * first keeps its id and the later ones take `@2`, `@3`, so an id stays
 * the same when the code around it moves. A summary whose boundary has
 * no key, such as a helper a route calls, is told apart by its order
 * alone, so a keyed sibling added beside it leaves its id as it was. A
 * summary named by a label, such as an Express handler named `get`,
 * always has its boundary in its id when it has one, because otherwise a
 * second route in the file would rename the first. The adapters run this
 * after assigning ids, and the parse boundary runs it over a backfilled
 * v1 artifact.
 */
export function disambiguateSummaryIds(summaries: BehavioralSummary[]): void {
  extendWithBoundary(summaries);
  numberInFileOrder(summaries);
}

/** The ids still shared, numbered by where each summary starts in its file. */
function numberInFileOrder(summaries: BehavioralSummary[]): void {
  const sharing = new Map<string, BehavioralSummary[]>();
  for (const summary of summaries) {
    const id = summary.identity.id;
    if (id === undefined) {
      continue;
    }
    const group = sharing.get(id);
    if (group === undefined) {
      sharing.set(id, [summary]);
      continue;
    }
    group.push(summary);
  }

  for (const group of sharing.values()) {
    if (group.length <= 1) {
      continue;
    }
    const ordered = [...group].sort((a, b) => startOf(a) - startOf(b));
    for (const [at, summary] of ordered.entries()) {
      if (at > 0) {
        summary.identity.id = `${summary.identity.id}@${at + 1}`;
      }
    }
  }
}

/** Where a summary starts, by character when the adapter recorded one. */
function startOf(summary: BehavioralSummary): number {
  return summary.location.span?.start ?? summary.location.range.start;
}

function extendWithBoundary(summaries: BehavioralSummary[]): void {
  const claimed = new Map<string, number>();
  for (const summary of summaries) {
    const id = summary.identity.id ?? "";
    claimed.set(id, (claimed.get(id) ?? 0) + 1);
  }
  const fromParent = labelParentBoundaries(summaries);

  for (const summary of summaries) {
    const id = summary.identity.id;
    const key = keyForId(summary, fromParent);
    if (id === undefined || key === null) {
      continue;
    }
    const shared = (claimed.get(id) ?? 0) > 1;
    if (shared || summary.identity.nameKind === "label") {
      summary.identity.id = `${id}#${key}`;
    }
  }
}

/** The boundary key a summary's id is extended with, its own or its labelled parent's, or null when it has neither. */
function keyForId(
  summary: BehavioralSummary,
  fromParent: ReadonlyMap<BehavioralSummary, string>,
): string | null {
  const binding = summary.identity.boundaryBinding;
  if (binding === null) {
    return null;
  }
  return boundaryKey(binding) ?? fromParent.get(summary) ?? null;
}

/**
 * The boundary each label-named summary with no key of its own is named
 * under: the key of the label-named summary it is written in and named
 * after. A timer `get.setTimeout#0` in the handler `get` for `GET /a` is
 * internal code with no key, and without its handler's route two such
 * timers under two `GET` routes in one file would be told apart only by
 * their order.
 */
function labelParentBoundaries(
  summaries: readonly BehavioralSummary[],
): Map<BehavioralSummary, string> {
  const keyedByFile = new Map<string, KeyedLabel[]>();
  const keyless: BehavioralSummary[] = [];
  for (const summary of summaries) {
    if (summary.identity.nameKind !== "label") {
      continue;
    }
    const binding = summary.identity.boundaryBinding;
    const key = binding === null ? null : boundaryKey(binding);
    if (key === null) {
      keyless.push(summary);
      continue;
    }
    const inFile = keyedByFile.get(summary.location.file);
    if (inFile === undefined) {
      keyedByFile.set(summary.location.file, [{ summary, key }]);
      continue;
    }
    inFile.push({ summary, key });
  }

  const found = new Map<BehavioralSummary, string>();
  for (const summary of keyless) {
    const parent = innermostParent(
      summary,
      keyedByFile.get(summary.location.file) ?? [],
    );
    if (parent !== null) {
      found.set(summary, parent.key);
    }
  }
  return found;
}

interface KeyedLabel {
  summary: BehavioralSummary;
  key: string;
}

/** The innermost labelled summary this one is written in and named after. */
function innermostParent(
  summary: BehavioralSummary,
  candidates: readonly KeyedLabel[],
): KeyedLabel | null {
  let found: KeyedLabel | null = null;
  for (const candidate of candidates) {
    if (
      !summary.identity.name.startsWith(
        `${candidate.summary.identity.name}.`,
      ) ||
      !encloses(candidate.summary, summary)
    ) {
      continue;
    }
    if (found === null || encloses(found.summary, candidate.summary)) {
      found = candidate;
    }
  }
  return found;
}

/** Whether `inner` is written inside `outer`, by character when both have a span. */
function encloses(outer: BehavioralSummary, inner: BehavioralSummary): boolean {
  const outerSpan = outer.location.span;
  const innerSpan = inner.location.span;
  if (outerSpan !== undefined && innerSpan !== undefined) {
    return outerSpan.start <= innerSpan.start && innerSpan.end <= outerSpan.end;
  }
  return (
    outer.location.range.start <= inner.location.range.start &&
    inner.location.range.end <= outer.location.range.end
  );
}

/**
 * How a report should refer to a summary that does not cross a
 * boundary.
 *
 * A summary that went through the parse boundary already has an id,
 * and a reader should see that id, because the run settled its
 * collisions. A summary passed straight to a checker skipped that step,
 * so the same formula runs here over the fields it does have: its file
 * and its export path. The result lacks the workspace, which only the
 * producer knows, and the collision settling, which needs the whole
 * run. Either form gives a reader a file to open, which a bare name
 * does not.
 */
export function summaryIdentifier(summary: BehavioralSummary): string {
  if (summary.identity.id !== undefined) {
    return summary.identity.id;
  }
  return summaryIdFromParts({
    workspace: undefined,
    file: summary.location.file,
    name: summary.identity.name,
    exportPath: summary.identity.exportPath,
  });
}

/** The id of a reader's copy of the summary `target` for one construction of its receiver. */
export function constructionCopyId(
  target: string,
  construction: string,
): string {
  return `${target} on ${construction}`;
}

/** The id of the summary a copy was made from, or the summary's own id when it is not a copy. */
export function originalIdOf(summary: BehavioralSummary): string {
  const id = summaryIdentifier(summary);
  const construction = summary.receiverConstruction;
  const suffix =
    construction === undefined ? "" : constructionCopyId("", construction);
  return id.slice(0, id.length - suffix.length);
}

/**
 * The id a summary has before settling adds a boundary or a number to it.
 * A reader matches a typed tail against this id, so the tail `evaluate`
 * matches this function's own name and not the export a caller of it
 * was settled with.
 */
export function unsettledSummaryId(summary: BehavioralSummary): string {
  return summaryIdFromParts({
    workspace: summary.location.workspace,
    file: summary.location.file,
    name: summary.identity.name,
    exportPath: summary.identity.exportPath,
  });
}

/**
 * What settling appended to a summary's id, or nothing. The id and the
 * summary can disagree about the workspace, so the match leaves it out.
 */
export function settlingSuffix(summary: BehavioralSummary): string {
  const id = originalIdOf(summary);
  const withoutWorkspace = summaryIdFromParts({
    workspace: undefined,
    file: summary.location.file,
    name: summary.identity.name,
    exportPath: summary.identity.exportPath,
  });
  const at = id.indexOf(withoutWorkspace);
  return at === -1 ? "" : id.slice(at + withoutWorkspace.length);
}

/**
 * The id built from a summary's own fields: its workspace when it has
 * one, its file, and its export path, or its name when it has no export
 * path.
 */
export function summaryIdFromParts(parts: SummaryIdParts): string {
  const reached =
    parts.exportPath !== null && parts.exportPath.length > 0
      ? parts.exportPath.join(".")
      : parts.name;
  return parts.workspace === undefined
    ? `${parts.file}::${reached}`
    : `${parts.workspace}::${parts.file}::${reached}`;
}

/**
 * How a summary writes the path of a file in another project, such as a
 * sibling package it imports: that project's name, then the file's path
 * from its root, the way an id starts. The same form is the key a join
 * compares two records of one file by. A file in the summary's own
 * project is written as a plain path, and so is one with no project name.
 */
export function fileReference(
  workspace: string | null | undefined,
  file: string,
): string {
  return workspace === null || workspace === undefined || workspace === ""
    ? file
    : `${workspace}::${file}`;
}

/**
 * The project and path a recorded file path points at. A plain path is
 * a file in the project of the summary that records it.
 */
export function referencedFile(
  owner: string | undefined,
  written: string,
): { workspace: string | undefined; file: string } {
  const at = written.indexOf("::");
  if (at === -1) {
    return { workspace: owner, file: written };
  }
  const workspace = written.slice(0, at);
  return {
    workspace: workspace === "" ? undefined : workspace,
    file: written.slice(at + 2),
  };
}

/** The key that joins a recorded path with the summaries of the file it points at. */
export function referencedFileKey(
  owner: string | undefined,
  written: string,
): string {
  const { workspace, file } = referencedFile(owner, written);
  return fileReference(workspace, file);
}

/** Whether two projects can be the same one, which they are when either is unknown. */
export function sameProject(
  one: string | undefined,
  other: string | undefined,
): boolean {
  return one === undefined || other === undefined || one === other;
}

/** The key that joins a summary's own file with the paths other summaries record for it. */
export function summaryFileKey(summary: BehavioralSummary): string {
  return fileReference(summary.location.workspace, summary.location.file);
}

/**
 * The key a render edge joins on: the workspace a component was
 * extracted in, the file it is declared in, and one of its names. Two
 * packages can have the same file path, so the file alone is not
 * enough. The producer writes `target` with the declaration's name, and
 * the checker indexes each summary under its name and its export path.
 * Both build the key here so they always agree. The separator is a NUL
 * character, which cannot appear in a path the way a space can.
 */
export function renderTargetKey(
  workspace: string | undefined,
  file: string,
  name: string,
): string {
  return `${workspace ?? ""}\u0000${file}\u0000${name}`;
}
