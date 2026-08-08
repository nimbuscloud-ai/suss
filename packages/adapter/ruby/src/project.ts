// project.ts: the adapter's whole contract, which is to discover units,
// emit summaries in the shared IR, and emit facts.
//
// It parses every file it is given, runs discovery over each one, hands
// each discovered unit to `@suss/extractor`'s `assembleSummary`, and
// emits this run's facts into one shared `Database`. That assembly
// layer is the same one the Python and TypeScript adapters use, so gap
// detection and confidence scoring are one implementation all three
// languages share.

import fs from "node:fs";
import path from "node:path";

import { Database } from "@suss/datalog";
import { assembleSummary } from "@suss/extractor";

import { createFileCache, discoverUnits } from "./discovery.js";
import { emitEntryFact } from "./facts.js";
import { parseRuby } from "./parser.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { RubyPack } from "./pack.js";

export interface ExtractRubyOptions {
  /** Absolute paths of the files to parse and extract. */
  files: string[];
  packs: RubyPack[];
  /** When set, `location.file` on each summary is relativized against this. */
  workspaceRoot?: string;
}

export interface ExtractRubyResult {
  summaries: BehavioralSummary[];
  facts: Database;
}

export async function extractRubyProject(
  options: ExtractRubyOptions,
): Promise<ExtractRubyResult> {
  const db = new Database();
  const summaries: BehavioralSummary[] = [];
  // One cache for the whole run, so a class that shows up both as an input file
  // and through a wiring keyword only gets parsed once.
  const cache = createFileCache(
    (source) => parseRuby(source).then((tree) => tree.rootNode),
    (absPath) =>
      fs.existsSync(absPath) ? fs.readFileSync(absPath, "utf8") : null,
  );

  for (const file of options.files) {
    const root = await cache.get(file);
    if (root === null) {
      continue;
    }
    // Facts keep the full filesystem path, because they are joined against
    // internally. Only the summary's `location.file` gets shortened.
    const displayPath =
      options.workspaceRoot !== undefined
        ? path.relative(options.workspaceRoot, file)
        : file;

    const rawUnits = await discoverUnits(root, {
      packs: options.packs,
      filePath: displayPath,
      cache,
    });
    for (const raw of rawUnits) {
      const summary = assembleSummary(raw, { gapHandling: "permissive" });
      // `assembleSummary` scores confidence on the assumption that a unit's
      // branches came from tracing its body. Nothing here traces a body, so
      // that score would be meaningless and we set confidence directly.
      summary.confidence = { source: "inferred_static", level: "low" };
      summaries.push(summary);
      emitEntryFact(db, file, raw.identity.range, raw.identity.name);
    }
  }

  return { summaries, facts: db };
}

const SKIPPED_DIRECTORIES = new Set(["vendor", "node_modules", "tmp", ".git"]);

/** Every `.rb` file under `root`, depth-first, skipping the usual non-source directories. */
export function findRubyFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) {
          walk(path.join(dir, entry.name));
        }
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".rb")) {
        found.push(path.join(dir, entry.name));
      }
    }
  };
  walk(root);
  return found.sort();
}
