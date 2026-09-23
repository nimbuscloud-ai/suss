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
 * Extend only the ids that more than one summary ended up with, and
 * leave the rest alone. An id without a collision stays short, and
 * stays the same when the code around it moves. The boundary tells
 * same-named summaries apart first, and the line number settles what
 * the boundary cannot. The adapter runs this after assigning ids, and
 * the parse boundary runs it over a backfilled v1 artifact, whose
 * per-summary backfill can give two summaries one id.
 */
export function disambiguateSummaryIds(summaries: BehavioralSummary[]): void {
  settleWith(summaries, (summary) =>
    summary.identity.boundaryBinding === null
      ? null
      : `#${boundaryKey(summary.identity.boundaryBinding)}`,
  );
  settleWith(summaries, (summary) => `@${summary.location.range.start}`);
}

function settleWith(
  summaries: BehavioralSummary[],
  discriminator: (summary: BehavioralSummary) => string | null,
): void {
  const claimed = new Map<string, number>();
  for (const summary of summaries) {
    const id = summary.identity.id ?? "";
    claimed.set(id, (claimed.get(id) ?? 0) + 1);
  }

  for (const summary of summaries) {
    if ((claimed.get(summary.identity.id ?? "") ?? 0) <= 1) {
      continue;
    }
    const extra = discriminator(summary);
    if (extra !== null) {
      summary.identity.id = `${summary.identity.id}${extra}`;
    }
  }
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

/**
 * The id a summary has before settling adds a boundary or a line to it.
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
  const id = summaryIdentifier(summary);
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
 * The key a render edge joins on: the file a component is declared in,
 * and one of the component's names. The producer writes `target` with
 * the declaration's name, and the checker indexes each summary under
 * its name and its export path. Both build the key here so they always
 * agree. The separator is a NUL character, which cannot appear in a
 * path the way a space can.
 */
export function renderTargetKey(file: string, name: string): string {
  return `${file}\u0000${name}`;
}
