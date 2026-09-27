/**
 * The entry point for a Python run. It discovers units, assembles their
 * summaries in the shared IR, and emits the run's facts into one `Database`.
 *
 * Every file is parsed and bound first, and the value facts are emitted
 * across all of them, before discovery runs on any file, because a mount in
 * one file can refer to a router built in another. Each discovered unit
 * goes through `@suss/extractor`'s `assembleSummary`, the same assembly the
 * TypeScript adapter uses, so both languages share one gap detection. With
 * a cache, a run after an edit replays the files and functions whose
 * inputs did not change, through the records in `reuse.ts`.
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
  DependencyLedger,
  FactLog,
  hashString,
  importedFilesByFile,
  mergeStoredDependencies,
  noDependencies,
  observeDemand,
  type PackWords,
  recordsToReplay,
  underQuestionSpend,
  walkRecordsByFile,
} from "@suss/resolution";

import { field, isFunction, rangeOf } from "./ast.js";
import {
  buildPythonExtractionReport,
  createPackTallies,
  tallyUnit,
} from "./diagnostics.js";
import { discoverUnits } from "./discovery.js";
import {
  bindEnvFacts,
  envFactsIn,
  envReadEffects,
  settleNamedParameters,
} from "./envReads.js";
import { emitValueFacts, nodeId } from "./facts/values.js";
import { emitModuleImportFacts } from "./facts.js";
import { importedDefinitionLookup } from "./importedDefinitions.js";
import { parsePython } from "./parser.js";
import { moduleLoadInvocationEffects } from "./paths/effects.js";
import { ReplayFailed, reachedFunctions } from "./reach/closure.js";
import {
  lookAgainIn,
  PackPositions,
  pythonEntryReuse,
  storedFunction,
  WalkReplay,
  WatchedNames,
  watchRouterIndex,
} from "./reuse.js";
import { buildRouterIndex } from "./routers.js";
import { bindModule } from "./scope.js";
import { pythonSourceRoots } from "./sourceRoots.js";
import { bindEvaluator, forgetEvaluations } from "./values/evaluator.js";
import { adapterStamp } from "./version.js";
import { buildWrapperIndex } from "./wrappers.js";

import type { BehavioralSummary, Effect } from "@suss/behavioral-ir";
import type {
  CacheAttribution,
  CacheDiagnostic,
  CacheInput,
  CacheLayer,
  ExtractionReport,
  ExtractorOptions,
  PartialPlan,
  RawCodeStructure,
  Timer,
  TimingReport,
} from "@suss/extractor";
import type {
  Changes,
  Dependencies,
  StoredDependencies,
  StoredFacts,
} from "@suss/resolution";
import type { PythonPack, StoragePattern } from "./pack.js";
import type { PyNode } from "./parser.js";
import type { ReachedUnits, Seed } from "./reach/closure.js";
import type {
  PythonEntryReuse,
  PythonFileRecord,
  StoredModule,
  StoredRegistration,
  StoredUnit,
} from "./reuse.js";
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
  /** Null when the file's record is replayed and its load-time unit comes from there. */
  readonly loadTimeReads: Effect[] | null;
}

/** A unit's record while the run that will store it is still going. */
type UnitDraft = { -readonly [K in keyof StoredUnit]: StoredUnit[K] };

/** What one file's discovery found and depended on, replayed or done in this run. */
interface FileDiscovery {
  readonly discovery: StoredDependencies;
  readonly units: readonly StoredUnit[];
  readonly registrations: readonly StoredRegistration[];
  readonly module: StoredModule;
}

/** The cache a run reads and writes, set up once for the run. */
interface RunCache {
  readonly timer: Timer;
  readonly cacheDir: string | null;
  readonly layer: CacheLayer<PythonFileRecord>;
  readonly input: CacheInput;
}

/** An earlier run's entry, when this run can replay parts of it. */
interface Previous {
  readonly plan: PartialPlan<PythonFileRecord>;
  readonly records: ReadonlyMap<string, PythonFileRecord>;
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
  const layer = createCacheLayer<PythonFileRecord>(cacheDir);
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
  const input: CacheInput = {
    files: cacheDir === null ? [] : options.files,
    adapterPacksDigest:
      cacheDir === null
        ? packsDigest
        : runDigest(packsDigest, options.packs, options.files),
  };
  const lookup = await timer.timeAsync("cache.lookup", () =>
    layer.lookup(input),
  );
  if (lookup.kind === "hit") {
    options.onCacheDiagnostic?.(lookup.diagnostic);
    options.onTiming?.(timer.report());
    return {
      summaries: lookup.summaries,
      facts: new Database(),
      roots,
      unreadManifests,
    };
  }

  const plan =
    lookup.diagnostic.missReason === "files-changed"
      ? await timer.timeAsync("cache.plan", () => layer.plan(input))
      : null;
  if (plan !== null && plan.changed.size === 0 && plan.removed.size === 0) {
    // Stamps moved but every content hash matched: a touch, not an edit.
    // Writing the entry again lets the next run hit on stats alone.
    try {
      await layer.write(input, plan.allSummaries(), plan.attribution());
    } catch {
      // A failed refresh costs the next run a rehash, nothing more.
    }
    options.onCacheDiagnostic?.({ kind: "hit" });
    options.onTiming?.(timer.report());
    return {
      summaries: plan.allSummaries(),
      facts: new Database(),
      roots,
      unreadManifests,
    };
  }

  const cache: RunCache = { timer, cacheDir, layer, input };
  const records =
    plan === null
      ? null
      : recordsToReplay<PythonFileRecord>(
          plan.roots,
          plan.changed,
          plan.removed,
        );
  let summaries: BehavioralSummary[] | null = null;
  let facts: Database | null = null;
  if (plan !== null && records !== null) {
    try {
      ({ summaries, facts } = await runPython(options, roots, cache, {
        plan,
        records,
      }));
    } catch (error) {
      if (!(error instanceof ReplayFailed)) {
        throw error;
      }
    }
  }
  if (summaries === null || facts === null) {
    options.onCacheDiagnostic?.(lookup.diagnostic);
    ({ summaries, facts } = await runPython(options, roots, cache, null));
  }
  return { summaries, facts, roots, unreadManifests };
}

async function runPython(
  options: ExtractPythonOptions,
  roots: string[],
  cache: RunCache,
  previous: Previous | null,
): Promise<{ summaries: BehavioralSummary[]; facts: Database }> {
  const { timer, cacheDir } = cache;
  const db = new Database();
  const summaries: BehavioralSummary[] = [];
  const gapHandling = options.gapHandling ?? "permissive";
  const tallies = createPackTallies(options.packs);
  // With a cache, every question and every read of another file is charged
  // to the file's discovery or the function's scan that made it.
  const ledger = cacheDir === null ? null : new DependencyLedger(options.files);
  const log = ledger === null ? null : new FactLog(db, ledger);
  if (ledger !== null) {
    observeDemand(db, ledger);
  }

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
      log?.startFile();
      emitModuleImportFacts(db, file, moduleBinding, { roots });
      if (needsValues) {
        emitValueFacts(db, file, root);
      }
      log?.endFile(file);
      indexDefinitions(definitions, file, root);
    }
    log?.startJoined();
    if (needsValues) {
      bindEvaluator(db, { files: bound, definitions });
      bindEnvFacts(db, envFacts);
    }
    addPackWords(db, packWordsOf(options.packs));
    if (ledger !== null) {
      settleNamedParameters(db);
    }
    log?.endJoined();
  });

  reportUnresolvedProjectModules(options.packs, roots, db);

  // A matching chain starts at a method declared in a file that imports the
  // library. A project that renames the method on the way is missed, since
  // asking the rules about every call instead would cost about a minute.
  const namesNearStorage = timer.time("discover", () =>
    methodsDeclaredNear(db, storagePatterns, definitions),
  );
  const couldMatch =
    ledger === null ? namesNearStorage : new WatchedNames(namesNearStorage, db);

  const plainRouterIndex = timer.time("discover", () =>
    buildRouterIndex(bound, options.packs, {
      roots,
      ...(mountsRouters ? { facts: db } : {}),
    }),
  );
  const positions = new PackPositions(options.packs);
  const routerIndex =
    ledger === null
      ? plainRouterIndex
      : watchRouterIndex(
          plainRouterIndex,
          db,
          positions,
          new Map(bound.map((one) => [one.module, one.file])),
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
  const filesByPath = new Map(bound.map((one) => [one.file, one]));

  const reuse: PythonEntryReuse | null =
    previous === null || log === null
      ? null
      : timer.time("cache.plan", () => {
          const changedFiles = previous.plan.changed;
          const changes: Changes = {
            files: new Set([...changedFiles].map(hashString)),
            values: log.changedValues(
              changedFiles,
              new Map(
                [...previous.records].map(([file, record]) => [
                  file,
                  record.facts,
                ]),
              ),
            ),
            lookAgain: lookAgainIn({
              db,
              couldMatch: namesNearStorage,
              routerIndex: plainRouterIndex,
              wrapperIndex,
              positions,
              moduleOfFile: new Map(bound.map((one) => [one.file, one.module])),
            }),
          };
          return pythonEntryReuse(previous.records, changedFiles, changes);
        });

  // Which wrappers the discovery being charged registered, so a replay of
  // its file can register the same ones in the same order.
  let registering: StoredRegistration[] | null = null;
  if (ledger !== null) {
    wrapperIndex.onRegistered = (target, declared) => {
      const form = positions.positionOf(declared);
      if (registering !== null && form !== undefined) {
        registering.push({
          key: nodeId(target.file.file, target.node),
          name: target.name,
          exportPath: target.exportPath,
          form,
        });
      }
    };
  }

  // A route asks the wrapper index about its own parameters as it is
  // discovered, so the wrapper units of a file are complete only once
  // every file has been discovered.
  const discovered = new Map<string, RawCodeStructure[]>();
  const discoveries = new Map<string, FileDiscovery>();
  const charges = new Map<string, Dependencies>();
  for (const boundFile of bound) {
    const { file, root, module: moduleBinding } = boundFile;
    const record = reuse?.discoveryOf(file);
    if (record !== undefined) {
      discoveries.set(file, record);
      for (const registration of record.registrations) {
        const declared = positions.formAt(registration.form);
        const target = storedFunction(registration, definitions, filesByPath);
        if (declared === undefined || target === null) {
          throw new ReplayFailed(registration.key);
        }
        wrapperIndex.registered(target, declared);
      }
      continue;
    }
    const storage = storageFor(boundFile);
    const discover = (): RawCodeStructure[] =>
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
      });
    const charge = noDependencies();
    const registrations: StoredRegistration[] = [];
    const rawUnits = timer.time("discover", () => {
      if (ledger === null) {
        return discover();
      }
      return ledger.charging(charge, () => {
        forgetEvaluations(db);
        ledger.readFile(file);
        registering = registrations;
        try {
          return discover();
        } finally {
          registering = null;
        }
      });
    });
    discovered.set(file, rawUnits);
    charges.set(file, charge);
    discoveries.set(file, {
      // Filled in when the entry is written, since the file's load-time
      // reads are charged to it after the walk.
      discovery: { files: "", values: "", checks: [] },
      units: [],
      registrations,
      module: { seedKey: null, summary: null },
    });
  }
  // More of a file's own work, after other files' work has run in between.
  const charged = <T>(file: string, work: () => T): T => {
    const charge = charges.get(file);
    if (ledger === null || charge === undefined) {
      return work();
    }
    return ledger.charging(charge, () => {
      forgetEvaluations(db);
      return work();
    });
  };

  const seeds: Seed[] = [];
  const summariesBySeed = new Map<string, BehavioralSummary[]>();
  const assembledHere = new Set<BehavioralSummary>();
  const moduleRoots: ModuleRoot[] = [];
  const unitDrafts = new Map<
    string,
    { summary: BehavioralSummary; draft: UnitDraft }[]
  >();
  let summariesReused = 0;
  const seedFrom = (
    key: string,
    boundFile: BoundPythonFile,
    summary: BehavioralSummary,
  ): void => {
    const node = definitions.get(key);
    if (node === undefined) {
      return;
    }
    const sharing = summariesBySeed.get(key);
    if (sharing === undefined) {
      seeds.push({ key, file: boundFile, node });
      summariesBySeed.set(key, [summary]);
    } else {
      sharing.push(summary);
    }
  };
  const assemble = (
    raw: RawCodeStructure,
    boundFile: BoundPythonFile,
  ): { summary: BehavioralSummary; seedKey: string | null } => {
    const summary = timer.time("summarize", () =>
      assembleSummary(raw, { gapHandling }),
    );
    // Every Python summary reports low confidence, in place of the score
    // `assembleSummary` computed.
    summary.confidence = { source: "inferred_static", level: "low" };
    summaries.push(summary);
    assembledHere.add(summary);
    tallyUnit(tallies, raw.boundaryBinding?.recognition);
    // Two routes on one function, such as one per method, share a seed.
    const span = raw.identity.span;
    const key =
      span === undefined ? null : `${boundFile.file}:${span.start}-${span.end}`;
    if (key !== null) {
      seedFrom(key, boundFile, summary);
    }
    return { summary, seedKey: key };
  };

  for (const boundFile of bound) {
    const { file, root, module: moduleBinding } = boundFile;
    const displayPath = displayPathOf(file);
    const record = reuse === null ? undefined : reuse.discoveryOf(file);
    if (record !== undefined && discoveries.get(file) === record) {
      for (const unit of record.units) {
        const summary = structuredClone(unit.summary);
        summariesReused += 1;
        summaries.push(summary);
        tallyUnit(tallies, unit.recognition);
        if (unit.seedKey !== undefined) {
          seedFrom(unit.seedKey, boundFile, summary);
        }
      }
    } else {
      const drafts: { summary: BehavioralSummary; draft: UnitDraft }[] = [];
      for (const raw of discovered.get(file) ?? []) {
        const { summary, seedKey } = assemble(raw, boundFile);
        const recognition = raw.boundaryBinding?.recognition;
        drafts.push({
          summary,
          draft: {
            ...(recognition === undefined ? {} : { recognition }),
            ...(seedKey === null || !definitions.has(seedKey)
              ? {}
              : { seedKey }),
            summary,
          },
        });
      }
      unitDrafts.set(file, drafts);
    }
    for (const raw of wrapperIndex.unitsIn(file)) {
      assemble(raw, boundFile);
    }

    const loadTimeReads =
      record !== undefined && discoveries.get(file) === record
        ? null
        : timer.time("discover", () =>
            charged(file, () => envReadEffects(root, moduleBinding, db)),
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
    } else if (loadTimeReads === null) {
      // The stored run seeded the module node itself, and this one would not.
      throw new ReplayFailed(moduleKey);
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
      ...(reuse === null
        ? {}
        : { replay: new WalkReplay(reuse, definitions, filesByPath) }),
      ...(ledger === null ? {} : { ledger }),
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
      // A replayed summary was placed by the run that stored it.
      if (assembledHere.has(summary)) {
        placeWhatItReached(summary, key);
      }
    }
  }
  if (ledger !== null) {
    for (const drafts of unitDrafts.values()) {
      for (const one of drafts) {
        one.draft.summary = structuredClone(one.summary);
      }
    }
  }
  if (gapHandling !== "silent") {
    recordParameterGaps(
      reached.parameterCallsByKey,
      summariesBySeed,
      reached.passedPositions,
    );
  }

  const modules = new Map<string, StoredModule>();
  for (const { boundFile, displayPath, key, loadTimeReads } of moduleRoots) {
    const record = discoveries.get(boundFile.file);
    if (loadTimeReads === null) {
      const stored = record?.module.summary ?? null;
      if (stored !== null) {
        summariesReused += 1;
        summaries.push(structuredClone(stored));
      }
      continue;
    }
    const calledAtLoad = reached.callsByKey.get(key) ?? [];
    if (loadTimeReads.length === 0 && calledAtLoad.length === 0) {
      modules.set(boundFile.file, { seedKey: key, summary: null });
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
            ...charged(boundFile.file, () =>
              moduleLoadInvocationEffects(boundFile.root, db),
            ).map(effectToIR),
          ],
        }),
        { gapHandling },
      ),
    );
    summary.confidence = { source: "inferred_static", level: "low" };
    placeWhatItReached(summary, key);
    summaries.push(summary);
    modules.set(boundFile.file, {
      seedKey: key,
      summary: ledger === null ? summary : structuredClone(summary),
    });
  }

  summaries.push(...reached.summaries);

  // An under-question given up on its budget depends on how much the run
  // asked before it, which a replay changes, so such a run starts over.
  const spend = underQuestionSpend(db);
  const overBudget = spend.abandoned + spend.skipped > 0;
  if (overBudget && reuse !== null) {
    throw new ReplayFailed("");
  }

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
      await cache.layer.write(
        cache.input,
        composed,
        log === null || ledger === null || overBudget
          ? undefined
          : pythonAttribution({
              composed,
              discoveries,
              charges,
              unitDrafts,
              modules,
              reached,
              reuse,
              ledger,
              facts: log.stored(
                bound.map(({ file }) => file),
                new Map(
                  [...(previous?.records ?? [])].map(([file, record]) => [
                    file,
                    record.facts,
                  ]),
                ),
                new Set(
                  previous === null
                    ? []
                    : bound
                        .map(({ file }) => file)
                        .filter((file) => !previous.plan.changed.has(file)),
                ),
              ),
            }),
      );
    } catch {
      // A failed cache write must not fail the extract.
    }
  });

  if (previous !== null && reuse !== null) {
    const libraryReused = [...reached.beforeGaps].filter(
      ([key, summary]) => reuse.walkOf(key)?.summary === summary,
    ).length;
    const filesReplayed = bound.filter(
      ({ file }) => discoveries.get(file) === reuse.records.get(file),
    ).length;
    options.onCacheDiagnostic?.({
      kind: "partial",
      partial: {
        filesChanged: previous.plan.changed.size,
        filesRemoved: 0,
        rootsReused: filesReplayed,
        rootsReextracted: bound.length - filesReplayed,
        rootsDeclined: 0,
        summariesReused: summariesReused + libraryReused,
      },
    });
  }

  options.onExtractionReport?.(
    buildPythonExtractionReport({
      packs: options.packs,
      tallies,
      filesWalked: options.files.length,
      summaries: composed,
    }),
  );
  options.onTiming?.(timer.report());

  return { summaries: composed, facts: db };
}

/** Every file's record for the entry this run writes. */
function pythonAttribution(args: {
  composed: readonly BehavioralSummary[];
  discoveries: ReadonlyMap<string, FileDiscovery>;
  /** What each file discovered in this run depended on, by the end of the run. */
  charges: ReadonlyMap<string, Dependencies>;
  unitDrafts: ReadonlyMap<
    string,
    readonly { summary: BehavioralSummary; draft: UnitDraft }[]
  >;
  modules: ReadonlyMap<string, StoredModule>;
  reached: ReachedUnits;
  reuse: PythonEntryReuse | null;
  facts: ReadonlyMap<string, StoredFacts>;
  ledger: DependencyLedger;
}): CacheAttribution<PythonFileRecord> {
  const walkedByFile = walkRecordsByFile({
    scans: args.reached.scans,
    charges: args.reached.charges,
    beforeGaps: args.reached.beforeGaps,
    replayed: (key) => args.reuse?.walkOf(key),
    store: (dependencies) => args.ledger.store(dependencies),
    merge: mergeStoredDependencies,
  });
  const roots = [...args.discoveries].map(([file, found]) => {
    const drafts = args.unitDrafts.get(file);
    const charge = args.charges.get(file);
    return {
      path: file,
      cacheable: true,
      deps: [],
      claims: [],
      packs: [],
      meta: {
        discovery:
          charge === undefined ? found.discovery : args.ledger.store(charge),
        units:
          drafts === undefined ? found.units : drafts.map(({ draft }) => draft),
        registrations: found.registrations,
        module: args.modules.get(file) ?? found.module,
        walked: walkedByFile.get(file) ?? [],
        facts: args.facts.get(file) ?? { own: "", joined: "" },
      },
    };
  });
  return { roots, owners: args.composed.map(() => []) };
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
