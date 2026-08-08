// project.ts: the adapter's whole contract, per facts-and-rules.md and
// the roadmap: discover units, emit summaries in the shared IR, emit
// facts. Parses every given file, runs the lexical binder and
// discovery over it, hands each discovered unit to `@suss/extractor`'s
// `assembleSummary` (the same assembly Layer 3 the TypeScript adapter
// uses, so gap detection and confidence scoring are the one
// implementation both languages share), and emits this run's facts
// into one shared `Database`.

import fs from "node:fs";
import path from "node:path";

import { Database } from "@suss/datalog";
import { assembleSummary } from "@suss/extractor";

import { discoverUnits } from "./discovery.js";
import { emitEntryFact, emitModuleImportFacts } from "./facts.js";
import { parsePython } from "./parser.js";
import { buildRouterIndex } from "./routers.js";
import { bindModule } from "./scope.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { ExtractorOptions } from "@suss/extractor";
import type { PythonPack } from "./pack.js";
import type { BoundPythonFile } from "./routers.js";

export interface ExtractPythonOptions {
  /** Absolute paths of the files to parse and extract. */
  files: string[];
  packs: PythonPack[];
  /** Directories an absolute import is resolved against; see moduleResolver.ts. */
  roots: string[];
  /** When set, `location.file` on each summary is relativized against this, mirroring `suss extract`'s repo-relative paths. */
  workspaceRoot?: string;
  /**
   * What to do with what nobody could read: "permissive" (the default)
   * and "silent" say how much of it reaches a summary, and "strict"
   * additionally lets a route the readers cannot turn into a unit stop
   * the run, which is what a caller who wants every unit or none asks
   * for.
   */
  gapHandling?: ExtractorOptions["gapHandling"];
}

export interface ExtractPythonResult {
  summaries: BehavioralSummary[];
  facts: Database;
}

export async function extractPythonProject(
  options: ExtractPythonOptions,
): Promise<ExtractPythonResult> {
  const db = new Database();
  const summaries: BehavioralSummary[] = [];
  const gapHandling = options.gapHandling ?? "permissive";

  // Parse and bind everything first: a route's path can depend on a
  // mount call in another file (a router constructed here, included
  // there), so the router index has to see the whole project before
  // any file's discovery runs.
  const bound: BoundPythonFile[] = [];
  for (const file of options.files) {
    const source = fs.readFileSync(file, "utf8");
    const tree = await parsePython(source);
    bound.push({
      file,
      root: tree.rootNode,
      module: bindModule(tree.rootNode),
    });
  }

  const routerIndex = buildRouterIndex(bound, options.packs, {
    roots: options.roots,
  });

  for (const { file, root, module: moduleBinding } of bound) {
    // Facts key on the filesystem path throughout, since they're an
    // internal join surface rather than user-facing text. The
    // summary's own `location.file` is what a project's workspace
    // convention gets to shorten.
    const displayPath =
      options.workspaceRoot !== undefined
        ? path.relative(options.workspaceRoot, file)
        : file;

    const rawUnits = discoverUnits(root, moduleBinding, {
      packs: options.packs,
      filePath: displayPath,
      routerIndex,
      gapHandling,
    });
    for (const raw of rawUnits) {
      const summary = assembleSummary(raw, { gapHandling });
      // `assembleSummary`'s confidence heuristic reads the ratio of
      // opaque to total conditions across a unit's branches, which
      // assumes those branches came from tracing the body. v0 never
      // does that (no path-engine work per the language-adapters
      // proposal): a route's one transition, when it has one, states
      // what a decorator keyword or an annotation declared, not what
      // running the code would show. That is a declared, unverified
      // claim regardless of how few or many conditions it carries, so
      // confidence is pinned low here rather than left to a heuristic
      // built for a different kind of reading.
      summary.confidence = { source: "inferred_static", level: "low" };
      summaries.push(summary);
      emitEntryFact(db, file, raw.identity.range, raw.identity.name);
    }

    emitModuleImportFacts(db, file, moduleBinding, { roots: options.roots });
  }

  return { summaries, facts: db };
}

const SKIPPED_DIRECTORIES = new Set([
  "__pycache__",
  ".venv",
  "venv",
  "node_modules",
  ".git",
]);

/** Every `.py` file under `root`, depth-first, skipping the usual non-source directories. Convenience for callers extracting a whole project rather than a hand-picked file list. */
export function findPythonFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) {
          walk(path.join(dir, entry.name));
        }
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".py")) {
        found.push(path.join(dir, entry.name));
      }
    }
  };
  walk(root);
  return found.sort();
}
