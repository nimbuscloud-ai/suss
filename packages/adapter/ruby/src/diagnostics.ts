/**
 * The extraction report for Ruby, built with the shared report in
 * `@suss/extractor`.
 *
 * Ruby does not gate a pack on the files that import its library yet,
 * so every pack sees every file and is reported the way TypeScript
 * reports a pack with no gate. The project walk fills in each pack's
 * `unitsDiscovered` and `summariesProduced` as it reads a file, and this
 * module reads them back.
 */

import {
  buildUngatedExtractionReport,
  createPackTallies,
  tallyUnit,
} from "@suss/extractor";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { ExtractionReport, PackTally } from "@suss/extractor";
import type { RubyPack } from "./pack.js";

export { createPackTallies, tallyUnit };
export type { PackTally };

export function buildRubyExtractionReport(args: {
  packs: ReadonlyArray<RubyPack>;
  tallies: ReadonlyMap<string, PackTally>;
  filesWalked: number;
  summaries: ReadonlyArray<BehavioralSummary>;
}): ExtractionReport {
  return buildUngatedExtractionReport({
    packs: args.packs.map((pack) => ({
      name: pack.name,
      version: pack.version ?? null,
      discovers: pack.discovery.length > 0,
    })),
    tallies: args.tallies,
    filesWalked: args.filesWalked,
    summaries: args.summaries,
  });
}
