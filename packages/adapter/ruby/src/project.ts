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

import {
  disambiguateSummaryIds,
  linkCallsToSummaries,
  placeCalls,
  summaryIdFromParts,
  unfollowedCallGap,
} from "@suss/behavioral-ir";
import { Database } from "@suss/datalog";
import {
  assembleSummary,
  moduleInitStructure,
  stampModuleImports,
} from "@suss/extractor";

import { instanceMethodsByName, rangeOf } from "./ast.js";
import { createFileCache, discoverUnits } from "./discovery.js";
import { envReadEffects } from "./envReads.js";
import {
  collectFileConstants,
  emitConstantBindings,
  type FileConstants,
} from "./facts/constants.js";
import { emitValueFacts, nodeId } from "./facts/values.js";
import { emitEntryFact, emitRequireFacts } from "./facts.js";
import { parseRuby } from "./parser.js";
import { reachedFunctions } from "./reach/closure.js";
import { walkDefinitions } from "./scope.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { RubyPack } from "./pack.js";
import type { RbNode } from "./parser.js";
import type { Seed } from "./reach/closure.js";

export interface ExtractRubyOptions {
  /** Absolute paths of the files to parse and extract. */
  files: string[];
  packs: RubyPack[];
  /** When set, `location.file` on each summary is relativized against this. */
  workspaceRoot?: string;
  /** The directory a summary's id measures its file from, when that differs from `workspaceRoot`. */
  projectRoot?: string;
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
  // Which file defines a constant is settled across the whole run, so the
  // reading sites wait until every file has been walked.
  const constants: FileConstants[] = [];
  // One cache for the whole run, so a class that shows up both as an input file
  // and through a wiring keyword only gets parsed once.
  const cache = createFileCache(
    (source) => parseRuby(source).then((tree) => tree.rootNode),
    (absPath) =>
      fs.existsSync(absPath) ? fs.readFileSync(absPath, "utf8") : null,
  );

  // Two passes, because which file declares a constant is settled across the
  // whole run, and the storage recognizer asks about that during discovery.
  const parsed: { file: string; root: RbNode }[] = [];
  for (const file of options.files) {
    const root = await cache.get(file);
    if (root === null) {
      continue;
    }
    parsed.push({ file, root });
    emitValueFacts(db, file, root);
    constants.push(collectFileConstants(file, root));
  }
  emitConstantBindings(db, constants);
  const known = new Set(parsed.map(({ file }) => file));
  for (const { file, root } of parsed) {
    emitRequireFacts(db, file, root, known);
  }

  const storagePatterns = options.packs.flatMap((pack) => pack.storage ?? []);
  // Facts keep the full filesystem path, because they are joined against
  // internally. Only the summary's `location.file` gets shortened.
  const displayPathOf = (file: string): string =>
    options.workspaceRoot !== undefined
      ? path.relative(options.workspaceRoot, file)
      : file;

  // A discovered unit whose span lands on a method here is a controller
  // action the reach walk can follow calls out of. A graphql-ruby field's
  // span points at its DSL call instead, which never matches.
  const methodsByKey = new Map<string, RbNode>();
  const enclosingClassOf = new Map<string, string>();
  for (const { file, root } of parsed) {
    walkDefinitions(root, (info) => {
      if (info.bodyNode === null) {
        return;
      }
      for (const method of instanceMethodsByName(info.bodyNode).values()) {
        const key = nodeId(file, method);
        methodsByKey.set(key, method);
        enclosingClassOf.set(key, info.qualifiedName);
      }
    });
  }

  const seeds: Seed[] = [];
  const summariesBySeed = new Map<string, BehavioralSummary[]>();

  for (const { file, root } of parsed) {
    const displayPath = displayPathOf(file);

    const rawUnits = await discoverUnits(root, {
      packs: options.packs,
      filePath: displayPath,
      absoluteFile: file,
      cache,
      ...(storagePatterns.length > 0
        ? { storage: { facts: db, patterns: storagePatterns } }
        : {}),
    });
    for (const raw of rawUnits) {
      const summary = assembleSummary(raw, { gapHandling: "permissive" });
      // `assembleSummary` scores confidence on the assumption that a unit's
      // branches came from tracing its body. Nothing here traces a body, so
      // that score would be meaningless and we set confidence directly.
      summary.confidence = { source: "inferred_static", level: "low" };
      summaries.push(summary);
      emitEntryFact(db, file, raw.identity.range, raw.identity.name);

      const span = raw.identity.span;
      const key =
        span === undefined ? null : `${file}:${span.start}-${span.end}`;
      const node = key === null ? undefined : methodsByKey.get(key);
      if (key === null || node === undefined) {
        continue;
      }
      const sharing = summariesBySeed.get(key);
      if (sharing === undefined) {
        seeds.push({
          key,
          file,
          node,
          enclosingQualifiedName: enclosingClassOf.get(key) ?? null,
        });
        summariesBySeed.set(key, [summary]);
      } else {
        sharing.push(summary);
      }
    }

    const loadTimeReads = envReadEffects(root);
    if (loadTimeReads.length > 0) {
      const summary = assembleSummary(
        moduleInitStructure({
          name: path.basename(displayPath),
          file: displayPath,
          range: rangeOf(root),
          effects: loadTimeReads,
        }),
        { gapHandling: "permissive" },
      );
      summary.confidence = { source: "inferred_static", level: "low" };
      summaries.push(summary);
    }
  }

  const reached = await reachedFunctions(seeds, {
    files: parsed,
    displayPathOf,
    ...(storagePatterns.length > 0
      ? { storage: { facts: db, patterns: storagePatterns } }
      : {}),
  });
  for (const [key, owners] of summariesBySeed) {
    for (const summary of owners) {
      summary.gaps.push(
        ...(reached.stopsByKey.get(key) ?? []).map(unfollowedCallGap),
      );
      placeCalls(summary, reached.targetsByKey.get(key));
    }
  }
  summaries.push(...reached.summaries);

  const dependencies = fileDependenciesOf(db, displayPathOf);
  stampModuleImports(summaries, (file) => dependencies.get(file) ?? []);

  // A summary's id is measured from the project root, because the CLI
  // shortens `location.file` to that root after this returns and an id
  // written from the longer path would not match it.
  const idRoot = options.projectRoot ?? options.workspaceRoot;
  for (const summary of summaries) {
    const absoluteFile =
      options.workspaceRoot === undefined
        ? summary.location.file
        : path.resolve(options.workspaceRoot, summary.location.file);
    summary.identity.id = summaryIdFromParts({
      workspace: undefined,
      file:
        idRoot === undefined
          ? absoluteFile
          : path.relative(idRoot, absoluteFile),
      name: summary.identity.name,
      exportPath: summary.identity.exportPath,
    });
  }
  disambiguateSummaryIds(summaries);
  linkCallsToSummaries(summaries);

  return { summaries, facts: db };
}

/**
 * The files each file depends on, spelled the way a summary's
 * location.file is. Ruby has no import statement to read, so this comes
 * from `require_relative` lines that resolve to a file in the run and
 * from constants this file reads that another file in the run defines.
 */
function fileDependenciesOf(
  db: Database,
  displayPathOf: (file: string) => string,
): Map<string, string[]> {
  const byFile = new Map<string, string[]>();
  for (const relation of ["rbRequires", "rbConstantFrom"]) {
    for (const [from, to] of db.facts(relation)) {
      if (typeof from !== "string" || typeof to !== "string") {
        continue;
      }
      const key = displayPathOf(from);
      const seen = byFile.get(key) ?? [];
      seen.push(displayPathOf(to));
      byFile.set(key, seen);
    }
  }
  return byFile;
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
