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
export function summaryIdFromParts(parts: SummaryIdParts): string {
  const reached =
    parts.exportPath !== null && parts.exportPath.length > 0
      ? parts.exportPath.join(".")
      : parts.name;
  return parts.workspace === undefined
    ? `${parts.file}::${reached}`
    : `${parts.workspace}::${parts.file}::${reached}`;
}
