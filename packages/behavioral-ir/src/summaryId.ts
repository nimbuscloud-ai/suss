// summaryId.ts: the id formula a summary's own fields add up to.
//
// The TypeScript adapter (nameSummaries) settles collisions across a
// whole run before it stamps this, which needs every summary the run
// produced. A producer that only ever sees one file at a time, a
// contract reader, or the legacy-artifact backfill in legacy.ts, has
// no run to settle against, so it gets the same base formula without
// the settling. Both call this rather than keeping their own copy, so
// the two never drift apart.

export interface SummaryIdParts {
  /** What the summary's project calls itself, when anything does. */
  workspace: string | undefined;
  /** The file the summary sits in, however the caller names it. */
  file: string;
  name: string;
  exportPath: string[] | null;
}

/**
 * The id a summary's own fields add up to: the workspace it names
 * itself under, the file it sits in, and its export path when it has
 * one or its name otherwise.
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
