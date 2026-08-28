/**
 * The formula that turns a summary's own fields into its id.
 *
 * The TypeScript adapter (nameSummaries) settles collisions across a
 * whole run before it stamps an id, and that takes every summary the
 * run produced. A producer that only ever sees one file at a time, a
 * contract reader or the legacy-artifact backfill, has no run to settle
 * against, so it gets the same base formula without the settling. Both
 * call this rather than keeping a copy, so the two cannot drift apart.
 */

import { boundaryKey } from "@suss/ir-core";

import type { BehavioralSummary } from "./index.js";

export interface SummaryIdParts {
  /** What the summary's project calls itself, when anything does. */
  workspace: string | undefined;
  /** The file the summary is in, spelled however the caller spells it. */
  file: string;
  name: string;
  exportPath: string[] | null;
}

/**
 * The id built out of a summary's own fields: the workspace it calls
 * itself part of, the file it is in, and its export path when it has
 * one, or its name when it does not.
 */
/**
 * Extend only the ids that more than one summary ended up with, and
 * leave the rest alone. An id nothing collides with stays short, and
 * stays the same when the code around it moves. The boundary tells
 * same-named summaries apart first, and the line number settles what
 * the boundary cannot. The adapter runs this after assigning ids, and
 * the parse boundary runs it over a backfilled v1 artifact, whose
 * per-summary backfill can mint one id for two summaries.
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
 * How a report should spell a summary that does not cross a boundary.
 *
 * A producer that ran through the parse boundary already has an id, and
 * that is what a reader should see, because the run settled its
 * collisions. A summary handed straight to a checker never went through
 * that step, so the same formula runs here over the fields it does
 * have: the file it is in and its export path. That leaves out the
 * workspace, which only the producer knows, and it leaves out the
 * collision settling, which needs the whole run. Both give a reader a
 * file to open, which a bare name does not.
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
 * The key a render edge joins on: the file a component is declared in
 * and one of its spellings. The producer writes `target` with the
 * declaration's name, the checker indexes each summary under its name
 * and its export path, and both sides mint the key here so the two
 * cannot drift apart. The separator cannot appear in a path, which a
 * space could.
 */
export function renderTargetKey(file: string, name: string): string {
  return `${file}\u0000${name}`;
}
