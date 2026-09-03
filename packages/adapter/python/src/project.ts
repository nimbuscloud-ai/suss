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

import { field, rangeOf } from "./ast.js";
import { discoverUnits } from "./discovery.js";
import { envReadEffects } from "./envReads.js";
import { emitValueFacts, nodeId } from "./facts/values.js";
import { emitEntryFact, emitModuleImportFacts } from "./facts.js";
import { parsePython } from "./parser.js";
import { reachedFunctions } from "./reach/closure.js";
import { buildRouterIndex } from "./routers.js";
import { bindModule } from "./scope.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { ExtractorOptions } from "@suss/extractor";
import type { PythonPack, StoragePattern } from "./pack.js";
import type { PyNode } from "./parser.js";
import type { Seed } from "./reach/closure.js";
import type { BoundPythonFile } from "./routers.js";
import type { StorageLookup } from "./storage.js";

export interface ExtractPythonOptions {
  /** Absolute paths of the files to parse and extract. */
  files: string[];
  packs: PythonPack[];
  /** Directories an absolute import is resolved against. */
  roots: string[];
  /** When set, `location.file` on each summary is relativized against this. */
  workspaceRoot?: string;
  /** The directory a summary's id measures its file from, when that differs from `workspaceRoot`. */
  projectRoot?: string;
  /** As well as deciding how much of what nobody could read reaches a summary, "strict" lets a route that cannot be built stop the run. */
  gapHandling?: ExtractorOptions["gapHandling"];
}

export interface ExtractPythonResult {
  summaries: BehavioralSummary[];
  facts: Database;
}

/**
 * A wrapper module a person configured that nothing imports never
 * matches a decorator, so the run comes back empty without saying why.
 * Say which one missed, once, after every file's imports are in the
 * facts.
 *
 * A wrapper module is usually an installed dependency, which never
 * resolves to a file under the project's own roots, so resolution is
 * not the right test here; whether some file imports it is.
 */
function reportUnresolvedProjectModules(
  options: ExtractPythonOptions,
  db: Database,
): void {
  const imported = new Set(db.facts("pyImport").map((row) => String(row[1])));
  for (const pack of options.packs) {
    for (const module of pack.projectModules ?? []) {
      if (imported.has(module)) {
        continue;
      }
      process.stderr.write(
        `[suss] ${pack.name}: no file under ${options.roots.join(", ")} imports ${module}, so the stub for it changes nothing.\n`,
      );
    }
  }
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

  // Discovery asks the rules what an object it cannot name was built by,
  // a pack that mounts routers asks them what a loop over a call
  // registers, and both read the value facts, so they are built once here.
  const mountsRouters = options.packs.some((pack) =>
    pack.discovery.some((pattern) => pattern.routerComposition !== undefined),
  );
  const storagePatterns = options.packs.flatMap((pack) => pack.storage ?? []);
  const rawSqlPatterns = options.packs.flatMap((pack) => pack.rawSql ?? []);
  const discovers = options.packs.some((pack) => pack.discovery.length > 0);
  const needsValues = discovers || mountsRouters || storagePatterns.length > 0;
  // Which function a resolved key was written as, so a recognizer can read
  // what it says it returns and the call walk can start from a route.
  const definitions = new Map<string, PyNode>();
  for (const { file, root, module: moduleBinding } of bound) {
    emitModuleImportFacts(db, file, moduleBinding, { roots: options.roots });
    if (needsValues) {
      emitValueFacts(db, file, root);
    }
    indexDefinitions(definitions, file, root);
  }

  reportUnresolvedProjectModules(options, db);

  // A chain that matches starts at a method some file importing the library
  // declares, so its name is in here. A project that renames one on the way
  // through is missed, which is what asking about every call would cost a
  // minute to catch.
  const couldMatch = methodsDeclaredNear(db, storagePatterns, definitions);

  const routerIndex = buildRouterIndex(bound, options.packs, {
    roots: options.roots,
    ...(mountsRouters ? { facts: db } : {}),
  });

  const storageFor = (file: BoundPythonFile): StorageLookup | undefined =>
    storagePatterns.length > 0 || rawSqlPatterns.length > 0
      ? {
          facts: db,
          factsPath: file.file,
          patterns: storagePatterns,
          definitionAt: (key: string) => definitions.get(key),
          couldMatch,
          rawSql: rawSqlPatterns,
        }
      : undefined;

  const seeds: Seed[] = [];
  const summariesBySeed = new Map<string, BehavioralSummary[]>();
  for (const boundFile of bound) {
    const { file, root, module: moduleBinding } = boundFile;
    const displayPath = displayPathOf(file);
    const storage = storageFor(boundFile);

    const rawUnits = discoverUnits(root, moduleBinding, {
      packs: options.packs,
      filePath: displayPath,
      absoluteFile: file,
      routerIndex,
      gapHandling,
      ...(needsValues ? { facts: db } : {}),
      ...(storage === undefined ? {} : { storage }),
    });
    for (const raw of rawUnits) {
      const summary = assembleSummary(raw, { gapHandling });
      // `assembleSummary` scores confidence on the assumption that a unit's
      // branches came from tracing its body. Nothing here traces a body, so
      // that score would be meaningless and we set confidence directly.
      summary.confidence = { source: "inferred_static", level: "low" };
      summaries.push(summary);
      emitEntryFact(db, file, raw.identity.range, raw.identity.name);

      // Two routes on one function, one per method say, share a seed.
      const span = raw.identity.span;
      const key =
        span === undefined ? null : `${file}:${span.start}-${span.end}`;
      const node = key === null ? undefined : definitions.get(key);
      if (key === null || node === undefined) {
        continue;
      }
      const sharing = summariesBySeed.get(key);
      if (sharing === undefined) {
        seeds.push({ key, file: boundFile, node });
        summariesBySeed.set(key, [summary]);
      } else {
        sharing.push(summary);
      }
    }

    const loadTimeReads = envReadEffects(root, moduleBinding);
    if (loadTimeReads.length > 0) {
      const summary = assembleSummary(
        moduleInitStructure({
          name: path.basename(displayPath),
          file: displayPath,
          range: rangeOf(root),
          effects: loadTimeReads,
        }),
        { gapHandling },
      );
      summary.confidence = { source: "inferred_static", level: "low" };
      summaries.push(summary);
    }
  }

  const reached = reachedFunctions(seeds, {
    files: bound,
    roots: options.roots,
    gapHandling,
    storageFor,
  });
  for (const [key, owners] of summariesBySeed) {
    for (const summary of owners) {
      if (gapHandling !== "silent") {
        summary.gaps.push(
          ...(reached.stopsByKey.get(key) ?? []).map(unfollowedCallGap),
        );
      }
      placeCalls(summary, reached.targetsByKey.get(key));
    }
  }
  summaries.push(...reached.summaries);

  const resolvedImports = resolvedImportsOf(db, displayPathOf);
  stampModuleImports(summaries, (file) => resolvedImports.get(file) ?? []);

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

/** The files each file's imports resolved to, spelled the way a summary's location.file is. */
function resolvedImportsOf(
  db: Database,
  displayPathOf: (file: string) => string,
): Map<string, string[]> {
  const importsByFile = new Map<string, string[]>();
  for (const [from, , to] of db.facts("pyImportResolved")) {
    if (typeof from !== "string" || typeof to !== "string") {
      continue;
    }
    const key = displayPathOf(from);
    const seen = importsByFile.get(key) ?? [];
    seen.push(displayPathOf(to));
    importsByFile.set(key, seen);
  }
  return importsByFile;
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

/** Every function in a file, under the key the facts give it. */
function indexDefinitions(
  into: Map<string, PyNode>,
  file: string,
  node: PyNode,
): void {
  if (node.type === "function_definition") {
    into.set(nodeId(file, node), node);
  }
  for (const child of node.namedChildren) {
    if (child !== null) {
      indexDefinitions(into, file, child);
    }
  }
}

/** What a file importing one of the libraries declares, by name. */
function methodsDeclaredNear(
  db: Database,
  patterns: readonly StoragePattern[],
  definitions: ReadonlyMap<string, PyNode>,
): Set<string> {
  const modules = new Set(patterns.map((pattern) => pattern.module));
  const importing = new Set(
    db
      .facts("pyImport")
      .filter((row) => modules.has(String(row[1])))
      .map((row) => String(row[0])),
  );
  const found = new Set<string>();
  for (const [key, node] of definitions) {
    const at = key.lastIndexOf(":");
    if (at === -1 || !importing.has(key.slice(0, at))) {
      continue;
    }
    const name = field(node, "name");
    if (name !== null) {
      found.add(name.text);
    }
  }
  return found;
}
