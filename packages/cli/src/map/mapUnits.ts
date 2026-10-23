/**
 * The units the page mentions, each listed once.
 *
 * A project of eight thousand functions mentions a few thousand of them
 * on the page, so the page lists only those, and everything else refers
 * to a unit by its place in this list.
 */

import path from "node:path";

import { summaryIdentifier } from "@suss/behavioral-ir";

import { LANGUAGE_LABEL, languageOfFile } from "../language.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { Language } from "../language.js";
import type { MapRead, MapUnit } from "./mapModel.js";

export class UnitTable {
  private readonly list: MapUnit[] = [];
  private readonly index = new Map<BehavioralSummary, number>();

  constructor(
    private readonly reads: readonly MapRead[],
    private readonly readOf: ReadonlyMap<BehavioralSummary, number>,
  ) {}

  of(summary: BehavioralSummary): number {
    const seen = this.index.get(summary);
    if (seen !== undefined) {
      return seen;
    }
    const read = this.readIndexOf(summary);
    const exportPath = summary.identity.exportPath ?? [];
    this.list.push({
      id: summaryIdentifier(summary),
      // A method is clearer with its class in front, which the export
      // path gives: `CommentsController.show` rather than `show`.
      name:
        exportPath.length > 1 ? exportPath.join(".") : summary.identity.name,
      kind: summary.kind,
      file: summary.location.file,
      line: summary.location.range.start,
      endLine: summary.location.range.end,
      read,
      spec: isSpecSummary(summary, this.reads[read]),
    });
    this.index.set(summary, this.list.length - 1);
    return this.list.length - 1;
  }

  all(): MapUnit[] {
    return this.list;
  }

  /** True when the summary came from a spec rather than from source. */
  isSpec(summary: BehavioralSummary): boolean {
    return isSpecSummary(summary, this.reads[this.readIndexOf(summary)]);
  }

  readIndexOf(summary: BehavioralSummary): number {
    return this.readOf.get(summary) ?? 0;
  }
}

/** The languages of the code summaries, most units first. */
export function languagesOf(
  summaries: readonly BehavioralSummary[],
  units: UnitTable,
): string[] {
  const counts = new Map<string, number>();
  for (const summary of summaries) {
    const language = languageOfFile(summary.location.file);
    if (language === null || units.isSpec(summary)) {
      continue;
    }
    counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([language]) => LANGUAGE_LABEL[language as Language]);
}

/**
 * A spec's summaries have no place in source code: `suss.json` says the
 * read was a contract, or the summary's file is a document such as
 * `openapi:api.json` rather than a file a language adapter reads.
 */
export function isSpecSummary(
  summary: BehavioralSummary,
  read: MapRead | undefined,
): boolean {
  return read?.spec === true || languageOfFile(summary.location.file) === null;
}

/** Where a link to a unit's file points, or null when the run does not know the root. */
export function absoluteFile(
  unit: MapUnit,
  reads: readonly MapRead[],
): string | null {
  const root = reads[unit.read]?.root;
  if (root === null || root === undefined || unit.spec) {
    return null;
  }
  return path.join(root, unit.file);
}
