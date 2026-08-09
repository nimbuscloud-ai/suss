// project.ts: the adapter's whole contract, which is to discover units,
// emit summaries in the shared IR, and emit facts.
//
// It parses every file it is given, runs the lexical binder and
// discovery over each one, hands each discovered unit to
// `@suss/extractor`'s `assembleSummary`, and emits this run's facts
// into one shared `Database`.
//
// `assembleSummary` is the same assembly layer the TypeScript adapter
// uses, so gap detection and confidence scoring are one implementation
// that both languages share.

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
  /** Directories an absolute import is resolved against. */
  roots: string[];
  /** When set, `location.file` on each summary is relativized against this. */
  workspaceRoot?: string;
  /** As well as deciding how much of what nobody could read reaches a summary, "strict" lets a route that cannot be built stop the run. */
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

  // Every file is parsed and bound before discovery runs on any of them,
  // because the router index has to see a mount written in one file and the
  // router it refers to constructed in another.
  //
  // Facts keep the full filesystem path, because they are joined against
  // internally. Only a summary's `location.file` gets shortened.
  const displayPathOf = (file: string): string =>
    options.workspaceRoot !== undefined
      ? path.relative(options.workspaceRoot, file)
      : file;

  const bound: BoundPythonFile[] = [];
  for (const file of options.files) {
    const source = fs.readFileSync(file, "utf8");
    const tree = await parsePython(source);
    bound.push({
      file,
      displayPath: displayPathOf(file),
      root: tree.rootNode,
      module: bindModule(tree.rootNode),
    });
  }

  for (const { file, module: moduleBinding } of bound) {
    emitModuleImportFacts(db, file, moduleBinding, { roots: options.roots });
  }

  const routerIndex = buildRouterIndex(bound, options.packs, {
    roots: options.roots,
  });

  for (const { file, root, module: moduleBinding } of bound) {
    const displayPath = displayPathOf(file);

    const rawUnits = discoverUnits(root, moduleBinding, {
      packs: options.packs,
      filePath: displayPath,
      routerIndex,
      gapHandling,
    });
    for (const raw of rawUnits) {
      const summary = assembleSummary(raw, { gapHandling });
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

const SKIPPED_DIRECTORIES = new Set([
  "__pycache__",
  ".venv",
  "venv",
  "node_modules",
  ".git",
]);

/** Every `.py` file under `root`, depth-first, skipping the usual non-source directories. */
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
