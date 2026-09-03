/**
 * The extraction funnel for Ruby, built on the shared report shape in
 * `@suss/extractor`.
 *
 * Ruby has no import-gate stage yet: every pack sees every file, the
 * way TypeScript reports an ungated pack.
 * `PackTally.unitsDiscovered` and `.summariesProduced` are filled by
 * `project.ts` as it walks each file, and read back here.
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
