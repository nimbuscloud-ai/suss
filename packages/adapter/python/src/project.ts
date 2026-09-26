/**
 * The entry point for a Python run. It discovers units, assembles their
 * summaries in the shared IR, and emits the run's facts into one `Database`.
 *
 * Every file is parsed and bound first, and the value facts are emitted
 * across all of them, before discovery runs on any file, because a mount in
 * one file can refer to a router built in another. Each discovered unit
 * goes through `@suss/extractor`'s `assembleSummary`, the same assembly the
 * TypeScript adapter uses, so both languages share one gap detection.
 */

import fs from "node:fs";
import path from "node:path";

import {
  disambiguateSummaryIds,
  linkCallsToSummaries,
  placeArgTargets,
  placeCalleeParameters,
  placeCalls,
  recordParameterGaps,
  summaryIdFromParts,
  unfollowedCallGap,
} from "@suss/behavioral-ir";
import { Database } from "@suss/datalog";
import {
  assembleSummary,
  composeWrappers,
  createCacheLayer,
  createTimer,
  effectToIR,
  extractionConfigStamp,
  moduleInitStructure,
  noopTimer,
  runDigest,
  stampModuleImports,
} from "@suss/extractor";
import {
  addPackWords,
  importedFilesByFile,
  type PackWords,
} from "@suss/resolution";

import { field, isFunction, rangeOf } from "./ast.js";
import {
  buildPythonExtractionReport,
  createPackTallies,
  tallyUnit,
} from "./diagnostics.js";
import { discoverUnits } from "./discovery.js";
import { bindEnvFacts, envFactsIn, envReadEffects } from "./envReads.js";
import { emitValueFacts, nodeId } from "./facts/values.js";
import { emitModuleImportFacts } from "./facts.js";
import { importedDefinitionLookup } from "./importedDefinitions.js";
import { parsePython } from "./parser.js";
import { moduleLoadInvocationEffects } from "./paths/effects.js";
import { reachedFunctions } from "./reach/closure.js";
import { buildRouterIndex } from "./routers.js";
import { bindModule } from "./scope.js";
import { pythonSourceRoots } from "./sourceRoots.js";
import { bindEvaluator } from "./values/evaluator.js";
import { adapterStamp } from "./version.js";
import { buildWrapperIndex } from "./wrappers.js";

import type { BehavioralSummary, Effect } from "@suss/behavioral-ir";
import type {
  CacheDiagnostic,
  CacheInput,
  CacheLayer,
  ExtractionReport,
  ExtractorOptions,
  RawCodeStructure,
  TimingReport,
} from "@suss/extractor";
import type { PythonPack, StoragePattern } from "./pack.js";
import type { PyNode } from "./parser.js";
import type { Seed } from "./reach/closure.js";
import type { BoundPythonFile } from "./routers.js";
import type { ModuleBinding } from "./scope.js";
import type { UnreadManifest } from "./sourceRoots.js";
import type { StorageLookup } from "./storage.js";

export interface ExtractPythonOptions {
  /** Absolute paths of the files to parse and extract. */
  files: string[];
  packs: PythonPack[];
  /**
   * Directories an absolute import is resolved against. When absent,
   * they are read from `projectRoot`: the directory itself and the
   * source directories its `pyproject.toml` declares, or `src/` when
   * it contains a package.
   */
  roots?: string[];
  /** Roots that cannot be found from the project directory, such as a checked-out submodule. Added after the others. */
  additionalRoots?: string[];
  /** When set, `location.file` on each summary is relativized against this. */
  workspaceRoot?: string;
  /** The directory a summary's id measures its file from, when that differs from `workspaceRoot`. */
  projectRoot?: string;
  /** How much of what could not be read goes on a summary. "strict" also makes a route that cannot be built stop the run. */
  gapHandling?: ExtractorOptions["gapHandling"];
  /** Called once with the run's per-phase wall time, for `suss extract --timing`. */
  onTiming?: (report: TimingReport) => void;
  /** Called once with the file-by-file funnel, for `suss extract --explain`. */
  onExtractionReport?: (report: ExtractionReport) => void;
  /** Called once with what the cache decided, for `suss extract --timing`. */
  onCacheDiagnostic?: (diagnostic: CacheDiagnostic) => void;
  /** Absolute. `<projectRoot>/.suss/cache` by default; `null` turns it off. */
  cacheDir?: string | null;
}

export interface ExtractPythonResult {
  summaries: BehavioralSummary[];
  facts: Database;
  /** The roots absolute imports were resolved against. */
  roots: string[];
  /** A manifest that might have declared a source directory and could not be read. */
  unreadManifests: UnreadManifest[];
}

function rootsOfRun(options: ExtractPythonOptions): {
  roots: string[];
  unreadManifests: UnreadManifest[];
} {
  const additional = options.additionalRoots ?? [];
  if (options.roots !== undefined) {
    return { roots: [...options.roots, ...additional], unreadManifests: [] };
  }

  if (options.projectRoot === undefined) {
    throw new Error(
      "extractPythonProject needs roots, or a projectRoot to read them from.",
    );
  }
  const found = pythonSourceRoots(options.projectRoot);
  return {
    roots: [...found.roots, ...additional],
    unreadManifests: found.unread,
  };
}

/**
 * A configured wrapper module that no file imports never matches a
 * decorator, and the run comes back empty without saying why. This reports
 * each one once, after every file's imports are in the facts. The test is
 * whether some file imports the module, because a wrapper is usually an
 * installed dependency that never resolves under the project's roots.
 */
function reportUnresolvedProjectModules(
  packs: readonly PythonPack[],
  roots: readonly string[],
  db: Database,
): void {
  const imported = new Set(
    db.facts("importsModule").map((row) => String(row[1])),
  );
  for (const pack of packs) {
    for (const module of pack.projectModules ?? []) {
      if (imported.has(module)) {
        continue;
      }
      process.stderr.write(
        `[suss] ${pack.name}: no file under ${roots.join(", ")} imports ${module}, so the stub for it changes nothing.\n`,
      );
    }
  }
}

/**
 * What the run's packs declare about their own libraries, in the form
 * `addPackWords` takes. The run does not read library source, so a pack's
 * model declarations are the only thing that says `session.get(User, id)`
 * is one User. A `with` block gets whatever `__enter__` returned, and only
 * the library knows that its own class returns the object it built.
 */
export function packWordsOf(packs: readonly PythonPack[]): PackWords {
  const models = packs.flatMap((pack) => pack.models ?? []);
  return {
    givesBackOne: models.flatMap((model) =>
      model.baseNames.flatMap((base) =>
        model.givesBack.map((method) => ({ base, method })),
      ),
    ),
    givesBackOneOfArgument: models.flatMap((model) =>
      model.baseNames.flatMap((base) =>
        model.entryMethods.map((entry) => ({ base, ...entry })),
      ),
    ),
    givesBackOneOfImport: models.flatMap((model) => model.entryFunctions),
    associationConstructor: models.flatMap(
      (model) => model.relationships ?? [],
    ),
    entersAsSelf: packs.flatMap((pack) =>
      (pack.contextManagers ?? []).flatMap((manager) =>
        manager.returnsSelf.map((name) => ({ module: manager.module, name })),
      ),
    ),
    unwrapsByName: packs.flatMap((pack) => pack.transparentWrappers ?? []),
  };
}

/** One parsed file and the packs a run over it would load. */
export interface FileFactsOptions {
  file: string;
  root: PyNode;
  module: ModuleBinding;
  packs: readonly PythonPack[];
}

/**
 * The facts for a single parsed file, with the evaluator bound to them,
 * for a caller that has one file and no project. A pack's own tests need
 * these: what built a receiver is an answer the rules give, and without
 * facts they have nothing to give it from. A project run emits the same
 * facts across every file at once, so a name written in another file
 * resolves there and never here.
 */
export function factsForFile(options: FileFactsOptions): Database {
  const db = new Database();
  emitModuleImportFacts(db, options.file, options.module, { roots: [] });
  emitValueFacts(db, options.file, options.root);
  const definitions = new Map<string, PyNode>();
  indexDefinitions(definitions, options.file, options.root);
  bindEvaluator(db, {
    files: [{ file: options.file, root: options.root, module: options.module }],
    definitions,
  });
  bindEnvFacts(db, [envFactsIn(options.file, options.root, options.module)]);
  addPackWords(db, packWordsOf(options.packs));
  return db;
}

/** One file's module scope, waiting on the walk to say what it called. */
interface ModuleRoot {
  readonly boundFile: BoundPythonFile;
  readonly displayPath: string;
  readonly key: string;
  readonly loadTimeReads: Effect[];
}

export async function extractPythonProject(
  options: ExtractPythonOptions,
): Promise<ExtractPythonResult> {
  const { roots, unreadManifests } = rootsOfRun(options);
  const timer = options.onTiming !== undefined ? createTimer() : noopTimer();

  const cacheDir = adapterStamp.declineWhenRunFromSource(
    options.cacheDir === null
      ? null
      : (options.cacheDir ??
          (options.projectRoot !== undefined
            ? path.join(options.projectRoot, ".suss", "cache")
            : null)),
  );
  const cache: CacheLayer = createCacheLayer(cacheDir);
  const packsDigest = `${adapterStamp.packsDigest(
    options.packs.map((pack) =>
      pack.version !== undefined
        ? { name: pack.name, version: pack.version }
        : { name: pack.name },
    ),
  )}|${extractionConfigStamp({
    gapHandling: options.gapHandling,
    workspaceRoot: options.workspaceRoot,
    projectRoot: options.projectRoot,
    // The same files read against other roots resolve other imports.
    importRoots: roots,
  })}`;
  const cacheInput: CacheInput = {
    files: cacheDir === null ? [] : options.files,
    adapterPacksDigest:
      cacheDir === null
        ? packsDigest
        : runDigest(packsDigest, options.packs, options.files),
  };
  const lookup = await timer.timeAsync("cache.lookup", () =>
    cache.lookup(cacheInput),
  );
  options.onCacheDiagnostic?.(lookup.diagnostic);
  if (lookup.kind === "hit") {
    options.onTiming?.(timer.report());
    return {
      summaries: lookup.summaries,
      facts: new Database(),
      roots,
      unreadManifests,
    };
  }

  const db = new Database();
  const summaries: BehavioralSummary[] = [];
  const gapHandling = options.gapHandling ?? "permissive";
  const tallies = createPackTallies(options.packs);

  // Facts keep the full filesystem path, because other facts are matched
  // against it. Only a summary's `location.file` is shortened.
  const displayPathOf = (file: string): string =>
    options.workspaceRoot !== undefined
      ? path.relative(options.workspaceRoot, file)
      : file;

  const bound: BoundPythonFile[] = [];
  for (const file of options.files) {
    await timer.timeAsync("parse", async () => {
      const source = fs.readFileSync(file, "utf8");
      const tree = await parsePython(source);
      bound.push({
        file,
        displayPath: displayPathOf(file),
        root: tree.rootNode,
        module: bindModule(tree.rootNode),
      });
    });
  }

  // Discovery asks the rules what built an object it cannot find by name,
  // and router mounting asks what a loop over a call registers. Both read
  // the value facts, so those are emitted once here for the whole run.
  const mountsRouters = options.packs.some((pack) =>
    pack.discovery.some((pattern) => pattern.routerComposition !== undefined),
  );
  const storagePatterns = options.packs.flatMap((pack) => pack.storage ?? []);
  const rawSqlPatterns = options.packs.flatMap((pack) => pack.rawSql ?? []);
  const sqlClients = options.packs.flatMap((pack) => pack.sqlClients ?? []);
  const modelQueries = options.packs.flatMap((pack) => pack.models ?? []);
  const discovers = options.packs.some((pack) => pack.discovery.length > 0);
  // A client pattern with a receiver asks the rules what built it.
  const buildsReceivers = options.packs.some((pack) =>
    (pack.clients ?? []).some(
      (client) => (client.receiverConstructors ?? []).length > 0,
    ),
  );
  // A helper that reads the environment through a parameter turns each of
  // its call sites into a read, so every file's environment facts have to
  // be collected before deciding whether the value facts are needed.
  const envFacts = bound.map((boundFile) =>
    envFactsIn(boundFile.file, boundFile.root, boundFile.module),
  );
  const readsEnvThroughNames = envFacts.some(
    (one) => one.sites.length > 0 || one.objects.length > 0,
  );
  const needsValues =
    discovers ||
    mountsRouters ||
    buildsReceivers ||
    readsEnvThroughNames ||
    storagePatterns.length > 0 ||
    modelQueries.length > 0 ||
    // A statement written as SQL is read through the evaluator, and so is
    // the client object the statement is passed to.
    rawSqlPatterns.length > 0 ||
    sqlClients.length > 0;
  // Which function a resolved key was written as, so a recognizer can read
  // what it says it returns and the call walk can start from a route.
  const definitions = new Map<string, PyNode>();
  timer.time("discover", () => {
    for (const { file, root, module: moduleBinding } of bound) {
      emitModuleImportFacts(db, file, moduleBinding, { roots });
      if (needsValues) {
        emitValueFacts(db, file, root);
      }
      indexDefinitions(definitions, file, root);
    }
    if (needsValues) {
      bindEvaluator(db, { files: bound, definitions });
      bindEnvFacts(db, envFacts);
    }
    addPackWords(db, packWordsOf(options.packs));
  });

  reportUnresolvedProjectModules(options.packs, roots, db);

  // A matching chain starts at a method declared in a file that imports the
  // library. A project that renames the method on the way is missed, since
  // asking the rules about every call instead would cost about a minute.
  const couldMatch = timer.time("discover", () =>
    methodsDeclaredNear(db, storagePatterns, definitions),
  );

  const routerIndex = timer.time("discover", () =>
    buildRouterIndex(bound, options.packs, {
      roots,
      ...(mountsRouters ? { facts: db } : {}),
    }),
  );

  const storageFor = (file: BoundPythonFile): StorageLookup | undefined =>
    storagePatterns.length > 0 ||
    rawSqlPatterns.length > 0 ||
    sqlClients.length > 0
      ? {
          facts: db,
          factsPath: file.file,
          patterns: storagePatterns,
          couldMatch,
          rawSql: rawSqlPatterns,
          sqlClients,
        }
      : undefined;

  const wrapperIndex = timer.time("discover", () =>
    buildWrapperIndex(bound, {
      packs: options.packs,
      roots,
      facts: needsValues ? db : undefined,
      definitions,
      storageFor,
    }),
  );

  const importedDefinition = importedDefinitionLookup(db, bound);

  // A route asks the wrapper index about its own parameters as it is
  // discovered, so the wrapper units of a file are complete only once
  // every file has been discovered.
  const discovered = new Map<string, RawCodeStructure[]>();
  for (const boundFile of bound) {
    const { file, root, module: moduleBinding } = boundFile;
    const storage = storageFor(boundFile);
    const rawUnits = timer.time("discover", () =>
      discoverUnits(root, moduleBinding, {
        packs: options.packs,
        filePath: displayPathOf(file),
        absoluteFile: file,
        routerIndex,
        gapHandling,
        wrappers: wrapperIndex,
        importedDefinition,
        ...(needsValues ? { facts: db } : {}),
        ...(storage === undefined ? {} : { storage }),
      }),
    );
    discovered.set(file, rawUnits);
  }

  const seeds: Seed[] = [];
  const summariesBySeed = new Map<string, BehavioralSummary[]>();
  const moduleRoots: ModuleRoot[] = [];
  for (const boundFile of bound) {
    const { file, root, module: moduleBinding } = boundFile;
    const displayPath = displayPathOf(file);
    const rawUnits = [
      ...(discovered.get(file) ?? []),
      ...wrapperIndex.unitsIn(file),
    ];
    for (const raw of rawUnits) {
      const summary = timer.time("summarize", () =>
        assembleSummary(raw, { gapHandling }),
      );
      // Every Python summary reports low confidence, in place of the score
      // `assembleSummary` computed.
      summary.confidence = { source: "inferred_static", level: "low" };
      summaries.push(summary);
      tallyUnit(tallies, raw.boundaryBinding?.recognition);

      // Two routes on one function, such as one per method, share a seed.
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

    const loadTimeReads = timer.time("discover", () =>
      envReadEffects(root, moduleBinding, db),
    );
    // What a module runs on the way in is a caller like any other, so it
    // joins the walk even when it reads nothing from the environment.
    const moduleKey = nodeId(file, root);
    if (!summariesBySeed.has(moduleKey)) {
      seeds.push({ key: moduleKey, file: boundFile, node: root });
      moduleRoots.push({
        boundFile,
        displayPath,
        key: moduleKey,
        loadTimeReads,
      });
    }
  }

  const reached = timer.time("summarize", () =>
    reachedFunctions(seeds, {
      files: bound,
      roots,
      gapHandling,
      storageFor,
      facts: db,
      definitions,
    }),
  );
  const placeWhatItReached = (
    summary: BehavioralSummary,
    key: string,
  ): void => {
    if (gapHandling !== "silent") {
      summary.gaps.push(
        ...(reached.stopsByKey.get(key) ?? []).map(unfollowedCallGap),
      );
    }
    placeCalls(summary, reached.targetsByKey.get(key));
    placeArgTargets(summary, reached.argTargetsByKey.get(key));
    placeCalleeParameters(summary, reached.parameterCallsByKey.get(key));
  };
  for (const [key, owners] of summariesBySeed) {
    for (const summary of owners) {
      placeWhatItReached(summary, key);
    }
  }
  if (gapHandling !== "silent") {
    recordParameterGaps(
      reached.parameterCallsByKey,
      summariesBySeed,
      reached.passedPositions,
    );
  }

  for (const { boundFile, displayPath, key, loadTimeReads } of moduleRoots) {
    const calledAtLoad = reached.callsByKey.get(key) ?? [];
    if (loadTimeReads.length === 0 && calledAtLoad.length === 0) {
      continue;
    }
    const summary = timer.time("summarize", () =>
      assembleSummary(
        moduleInitStructure({
          name: path.basename(displayPath),
          file: displayPath,
          range: rangeOf(boundFile.root),
          effects: [
            ...loadTimeReads,
            ...moduleLoadInvocationEffects(boundFile.root, db).map(effectToIR),
          ],
        }),
        { gapHandling },
      ),
    );
    summary.confidence = { source: "inferred_static", level: "low" };
    placeWhatItReached(summary, key);
    summaries.push(summary);
  }

  summaries.push(...reached.summaries);

  const resolvedImports = importedFilesByFile(db, displayPathOf);
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
  const composed = timer.time("summarize", () =>
    composeWrappers(summaries, { gapHandling }),
  );

  await timer.timeAsync("cache.write", async () => {
    // An empty result is never cached. Serving one would skip the
    // stages that fill the funnel, so a misconfigured project would
    // get "0 summaries" with no explanation ever after.
    if (cacheDir === null || composed.length === 0) {
      return;
    }
    try {
      await cache.write(cacheInput, composed);
    } catch {
      // A failed cache write must not fail the extract.
    }
  });

  options.onExtractionReport?.(
    buildPythonExtractionReport({
      packs: options.packs,
      tallies,
      filesWalked: options.files.length,
      summaries: composed,
    }),
  );
  options.onTiming?.(timer.report());

  return {
    summaries: composed,
    facts: db,
    roots,
    unreadManifests,
  };
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
  if (isFunction(node)) {
    into.set(nodeId(file, node), node);
  }
  for (const child of node.namedChildren) {
    if (child !== null) {
      indexDefinitions(into, file, child);
    }
  }
}

/** The names of the functions declared in files that import one of the storage libraries. */
function methodsDeclaredNear(
  db: Database,
  patterns: readonly StoragePattern[],
  definitions: ReadonlyMap<string, PyNode>,
): Set<string> {
  const modules = new Set(patterns.map((pattern) => pattern.module));
  const importing = new Set(
    db
      .facts("importsModule")
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
