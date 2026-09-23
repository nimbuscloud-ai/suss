/**
 * The extraction report for a Python run, built from the shared report
 * in `@suss/extractor`.
 *
 * Python does not gate a pack on the file's imports yet, so every pack
 * sees every file and the report reads the way TypeScript reports an
 * ungated pack. The project walk fills in each pack's tally as it reads
 * a file, and this module only turns the tallies into the report.
 */

import {
  buildUngatedExtractionReport,
  createPackTallies,
  tallyUnit,
} from "@suss/extractor";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { ExtractionReport, PackTally } from "@suss/extractor";
import type { PythonPack } from "./pack.js";

export { createPackTallies, tallyUnit };
export type { PackTally };

export function buildPythonExtractionReport(args: {
  packs: ReadonlyArray<PythonPack>;
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
