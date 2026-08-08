// project.ts: the adapter's whole contract, per facts-and-rules.md and
// the roadmap: discover units, emit summaries in the shared IR, emit
// facts. Parses every given file, runs discovery over it, hands each
// discovered unit to `@suss/extractor`'s `assembleSummary` (the same
// assembly Layer 3 the Python and TypeScript adapters use), and emits
// this run's facts into one shared `Database`.

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
  /** When set, `location.file` on each summary is relativized against this, mirroring `suss extract`'s repo-relative paths. */
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
  // One cache for the whole run: a class referenced from a field
  // through a wiring keyword parses once, whether it's also one of
  // `options.files` or reached only through the constant-to-path
  // convention.
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
    // Facts key on the filesystem path throughout, since they're an
    // internal join surface rather than user-facing text. The
    // summary's own `location.file` is what a project's workspace
    // convention gets to shorten.
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
      // A field carries the method behind it, and nothing traced
      // through that method: v0 does no path-engine work, per the
      // language-adapters proposal. So confidence is pinned low here
      // rather than left to a heuristic built for a transition-bearing
      // summary, the same convention the Python adapter's v0 slice
      // follows.
      summary.confidence = { source: "inferred_static", level: "low" };
      summaries.push(summary);
      emitEntryFact(db, file, raw.identity.range, raw.identity.name);
    }
  }

  return { summaries, facts: db };
}

const SKIPPED_DIRECTORIES = new Set(["vendor", "node_modules", "tmp", ".git"]);

/** Every `.rb` file under `root`, depth-first, skipping the usual non-source directories. Convenience for callers extracting a whole project rather than a hand-picked file list. */
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
