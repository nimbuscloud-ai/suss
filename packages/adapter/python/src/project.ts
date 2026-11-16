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
  placePossibleCalls,
  placeReceivers,
  recordParameterGaps,
  summaryIdFromParts,
  unfollowedCallGap,
} from "@suss/behavioral-ir";
import { readTestFilesFrom } from "@suss/behavioral-ir/files";
import { Database } from "@suss/datalog";
import {
  assembleSummary,
  composeWrappers,
  createCacheLayer,
  createTimer,
  effectToIR,
  extractionCacheDirFor,
  extractionConfigStamp,
  KeptParses,
  libraryEnvReadMarkers,
  moduleInitStructure,
  noopTimer,
  ownersWhereWritten,
  packRecognizers,
  pooledWords,
  runDigest,
  runRootOf,
  stampModuleImports,
  stampModules,
  storedPathsOfRun,
} from "@suss/extractor";
import {
  addPackWords,
  DependencyLedger,
  FactLog,
  factsKeptFrom,
  importedFilesByFile,
  mergeStoredDependencies,
  noDependencies,
  observeDemand,
  type PackWords,
  recordsToReplay,
  replayChanges,
  underQuestionSpend,
  walkRecordsByFile,
} from "@suss/resolution";

import { children, isFunction, rangeOf } from "./ast.js";
import { declaredDiscoveryUnits } from "./declaredDiscovery.js";
import {
  buildPythonExtractionReport,
  createPackTallies,
  tallyUnit,
} from "./diagnostics.js";
import { discoverUnits } from "./discovery.js";
import { bindEnvFacts, envFactsIn, settleNamedParameters } from "./envReads.js";
import { exitSites, type FileExits, markExitCodeFunctions } from "./exits.js";
import { emitValueFacts, nodeId } from "./facts/values.js";
import { emitModuleImportFacts } from "./facts.js";
import { importedDefinitionLookup } from "./importedDefinitions.js";
import { bindJobQueues, jobConsumerUnits } from "./jobQueues.js";
import { moduleExportUnits, settlePythonModules } from "./moduleSurface.js";
import { parsePython } from "./parser.js";
import { moduleLoadInvocationEffects } from "./paths/effects.js";
import { bindRequestObjects } from "./provenance.js";
import { ReplayFailed, reachedFunctions } from "./reach/closure.js";
import {
  lookAgainIn,
  PackPositions,
  pythonEntryReuse,
  storedFunction,
  WalkReplay,
  watchRouteTables,
} from "./reuse.js";
import { buildRouteTables } from "./routeTables.js";
import { bindModule } from "./scope.js";
import { pythonSourceRoots } from "./sourceRoots.js";
import { stdlibReads } from "./stdlib/dispatch.js";
import { claimsLambdas, subUnitClaims } from "./subUnits.js";
import { pythonTestIndex } from "./testCases.js";
import { bindEvaluator, forgetEvaluations } from "./values/evaluator.js";
import { adapterStamp } from "./version.js";
import { buildWrapperIndex } from "./wrappers.js";

import type { BehavioralSummary, Effect } from "@suss/behavioral-ir";
import type {
  CacheAttribution,
  CacheDiagnostic,
  CacheInput,
  CacheLayer,
  DeclaredModule,
  ExtractionReport,
  ExtractorOptions,
  PackTally,
  PartialPlan,
  RawCodeStructure,
  ReceiverOrigin,
  Timer,
  TimingReport,
} from "@suss/extractor";
import type {
  AssociationConstructor,
  Dependencies,
  StoredDependencies,
  StoredFacts,
} from "@suss/resolution";
import type { BoundPythonFile } from "./boundFiles.js";
import type { PythonPack } from "./pack.js";
import type { PyNode } from "./parser.js";
import type { ReachedUnits, Seed } from "./reach/closure.js";
import type { ReachedFunction } from "./reach/resolveCallee.js";
import type {
  PythonEntryReuse,
  PythonFileRecord,
  StoredModule,
  StoredRegistration,
  StoredUnit,
} from "./reuse.js";
import type { ModuleBinding } from "./scope.js";
import type { UnreadManifest } from "./sourceRoots.js";
import type { StorageLookup } from "./storage.js";
import type {
  DecoratorClosure,
  FormOf,
  PythonWrapperIndex,
} from "./wrappers.js";

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
  /** Absolute. `<projectRoot>/.suss/cache` by default, or under `SUSS_CACHE_DIR`; `null` turns it off. */
  cacheDir?: string | null;
  /** The modules the project lists in `suss.json`, with absolute paths. */
  modules?: readonly DeclaredModule[];
  /** Parses an earlier run in this process left, for a file whose text is unchanged. */
  keptParses?: KeptPythonParses;
}

/** A file's tree and the scopes bound over it, as a later run can reuse them. */
export type KeptPythonParses = KeptParses<{
  root: PyNode;
  module: ModuleBinding;
}>;

/** A holder for parses between runs, which frees each tree it lets go of. */
export function keptPythonParses(): KeptPythonParses {
  return new KeptParses(({ root }) => root.tree.delete());
}

/**
 * Parses these files into `kept` before any run needs them. A run served
 * whole from the cache parses nothing, so a process that keeps parses
 * calls this while nobody is waiting.
 */
export async function parsePythonAhead(
  files: readonly string[],
  kept: KeptPythonParses,
): Promise<void> {
  for (const file of files) {
    await kept.parse(file, fs.readFileSync(file, "utf8"), parseAndBind);
  }
  kept.keepOnly(files);
}

async function parseAndBind(
  source: string,
): Promise<{ root: PyNode; module: ModuleBinding }> {
  const tree = await parsePython(source);
  return { root: tree.rootNode, module: bindModule(tree.rootNode) };
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
 * What the run's packs say about their own libraries, in the form
 * `addPackWords` takes, since the run does not read library source.
 */
export function packWordsOf(packs: readonly PythonPack[]): PackWords {
  return {
    ...pooledWords(packs),
    associationConstructor: packs.flatMap((pack) =>
      (pack.classBodies ?? []).flatMap((body) =>
        constructorsOf(body.fields.association?.madeBy),
      ),
    ),
    entersAsSelf: packs.flatMap((pack) =>
      (pack.contextManagers ?? []).flatMap((manager) =>
        manager.returnsSelf.map((name) => ({ module: manager.module, name })),
      ),
    ),
    unwrapsByName: packs.flatMap((pack) => pack.transparentWrappers ?? []),
  };
}

/**
 * The callables a field is assigned from to declare an association, as
 * the rule that joins `fieldCall` to the import reads them. Only an
 * import says which callable, so any other origin gives none.
 */
function constructorsOf(
  origin: ReceiverOrigin | undefined,
): AssociationConstructor[] {
  if (origin?.origin !== "imported") {
    return [];
  }
  const { importedFrom, named = [] } = origin;
  return importedFrom.flatMap((module) =>
    named.map((name) => ({ module, name })),
  );
}

/** One parsed file and the packs a run over it would load. */
export interface FileFactsOptions {
  file: string;
  root: PyNode;
  module: ModuleBinding;
  packs: readonly PythonPack[];
  /** Directories an import is resolved against. Without them no import leads to a file. */
  roots?: readonly string[];
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
  emitModuleImportFacts(db, options.file, options.module, {
    roots: [...(options.roots ?? [])],
  });
  emitValueFacts(db, options.file, options.root);
  const definitions = new Map<string, PyNode>();
  indexDefinitions(definitions, options.file, options.root);
  bindEvaluator(db, {
    files: [{ file: options.file, root: options.root, module: options.module }],
    definitions,
  });
  bindEnvFacts(db, [envFactsIn(options.file, options.root, options.module)]);
  bindRequestObjects(
    db,
    options.packs.flatMap((pack) => pack.requestObjects ?? []),
  );
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
            ? extractionCacheDirFor(options.projectRoot)
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
    modules: settlePythonModules(options.modules),
  })}`;
  // A hook that builds the key runs before any try at the run has
  // tallies of its own, so its failure is kept here and each try starts
  // from it.
  const beforeLookup = createPackTallies(options.packs);
  const input: CacheInput = {
    files: cacheDir === null ? [] : options.files,
    adapterPacksDigest:
      cacheDir === null
        ? packsDigest
        : runDigest(packsDigest, options.packs, options.files, {
            asStored: storedPathsOfRun(options.files[0]).paths.keyText,
            tallies: beforeLookup,
            root: runRootOf(options),
          }),
  };
  const lookup = await timer.timeAsync("cache.lookup", () =>
    layer.lookup(input),
  );
  // The cache stores summaries before their wrappers are composed, so a
  // stored route stays its own, and every path composes on the way out.
  const composed = (stored: readonly BehavioralSummary[]) =>
    composeWrappers(stored, {
      gapHandling: options.gapHandling ?? "permissive",
    });
  if (lookup.kind === "hit") {
    options.onCacheDiagnostic?.(lookup.diagnostic);
    options.onTiming?.(timer.report());
    return {
      summaries: composed(lookup.summaries),
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
      summaries: composed(plan.allSummaries()),
      facts: new Database(),
      roots,
      unreadManifests,
    };
  }

  const cache: RunCache = { timer, cacheDir, layer, input };
  // A file's records do not store the summaries of the lambdas a pack
  // claims, so a run with such a pack reads every file again rather than
  // replay a parent without them.
  const records =
    plan === null || claimsLambdas(options.packs)
      ? null
      : recordsToReplay<PythonFileRecord>(plan.roots);
  let summaries: BehavioralSummary[] | null = null;
  let facts: Database | null = null;
  if (plan !== null && records !== null) {
    try {
      ({ summaries, facts } = await runPython(
        options,
        roots,
        cache,
        { plan, records },
        beforeLookup,
      ));
    } catch (error) {
      if (!(error instanceof ReplayFailed)) {
        throw error;
      }
    }
  }
  if (summaries === null || facts === null) {
    options.onCacheDiagnostic?.(lookup.diagnostic);
    ({ summaries, facts } = await runPython(
      options,
      roots,
      cache,
      null,
      beforeLookup,
    ));
  }
  return { summaries, facts, roots, unreadManifests };
}

/**
 * The directory a summary's id measures its file from. The CLI shortens
 * `location.file` to it after the run, so an id written from the longer
 * path would not match, and which files are test code is read from it
 * too, so the facts and pairing agree on them.
 */
function summaryRootOf(options: ExtractPythonOptions): string | undefined {
  return options.projectRoot ?? options.workspaceRoot;
}

async function runPython(
  options: ExtractPythonOptions,
  roots: string[],
  cache: RunCache,
  previous: Previous | null,
  beforeLookup: ReadonlyMap<string, PackTally>,
): Promise<{ summaries: BehavioralSummary[]; facts: Database }> {
  const { timer, cacheDir } = cache;
  const db = new Database();
  const summaryRoot = summaryRootOf(options);
  if (summaryRoot !== undefined) {
    readTestFilesFrom(db, summaryRoot);
  }
  const summaries: BehavioralSummary[] = [];
  const gapHandling = options.gapHandling ?? "permissive";
  const tallies = createPackTallies(options.packs, beforeLookup);
  // With a cache, every question and every read of another file is charged
  // to the file's discovery or the function's scan that made it.
  const ledger =
    cacheDir === null
      ? null
      : new DependencyLedger(
          options.files,
          storedPathsOfRun(options.files[0]).paths.keyText,
        );
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
  const parses = options.keptParses ?? keptPythonParses();
  for (const file of options.files) {
    await timer.timeAsync("parse", async () => {
      const source = fs.readFileSync(file, "utf8");
      const { root, module } = await parses.parse(file, source, parseAndBind);
      bound.push({ file, displayPath: displayPathOf(file), root, module });
    });
  }
  options.keptParses?.keepOnly(options.files);

  // Every body's environment reads go through the read chains, which ask
  // the value facts, so those are emitted once here for the whole run.
  // Discovery, the route tables and the packs' hooks ask them too.
  const declaredHooks = packRecognizers(options.packs, tallies);
  // A module's public exports are discovered like a pack's routes.
  const declaredModules = settlePythonModules(options.modules);
  const envFacts = bound.map((boundFile) =>
    envFactsIn(boundFile.file, boundFile.root, boundFile.module),
  );
  // An exit handing over a value is followed back to the functions whose
  // return that value is, which is a question over the value facts too.
  const exits: FileExits[] = bound.map(({ file, root, module }) => ({
    file,
    sites: exitSites(root, module),
  }));
  // Which function a resolved key was written as, so a recognizer can read
  // what it says it returns and the call walk can start from a route.
  const definitions = new Map<string, PyNode>();
  timer.time("discover", () => {
    for (const { file, root, module: moduleBinding } of bound) {
      log?.startFile();
      emitModuleImportFacts(db, file, moduleBinding, { roots });
      emitValueFacts(db, file, root);
      log?.endFile(file);
      indexDefinitions(definitions, file, root);
    }
    log?.startJoined();
    bindEvaluator(db, { files: bound, definitions });
    bindEnvFacts(db, envFacts);
    bindJobQueues(db, options.packs, roots);
    bindRequestObjects(
      db,
      options.packs.flatMap((pack) => pack.requestObjects ?? []),
    );
    addPackWords(db, packWordsOf(options.packs));
    if (ledger !== null) {
      settleNamedParameters(db);
    }
    log?.endJoined();
  });

  reportUnresolvedProjectModules(options.packs, roots, db);
  const subUnits = subUnitClaims(db, options.packs, tallies);

  const positions = new PackPositions(options.packs);
  const plainRoutes = timer.time("discover", () =>
    buildRouteTables(bound, options.packs, db),
  );
  const routes =
    ledger === null
      ? plainRoutes
      : watchRouteTables(plainRoutes, db, positions);

  const filesByPath = new Map(bound.map((one) => [one.file, one]));
  const storageFor = (file: BoundPythonFile): StorageLookup | undefined =>
    declaredHooks.length > 0
      ? {
          facts: db,
          factsPath: file.file,
          files: filesByPath,
          declared: declaredHooks,
        }
      : undefined;

  const wrapperIndex = timer.time("discover", () =>
    buildWrapperIndex(bound, {
      packs: options.packs,
      roots,
      facts: db,
      definitions,
      storageFor,
      routes: plainRoutes,
    }),
  );

  const importedDefinition = importedDefinitionLookup(db, bound);
  const tests = pythonTestIndex(options.packs, {
    filesByPath,
    roots,
    facts: db,
  });

  const reuse: PythonEntryReuse | null =
    previous === null || log === null || ledger === null
      ? null
      : timer.time("cache.plan", () => {
          const changes = replayChanges({
            files: options.files,
            plan: previous.plan,
            records: previous.records,
            ledger,
            log,
            lookAgain: lookAgainIn({
              db,
              routes: plainRoutes,
              wrapperIndex,
              positions,
              moduleOfFile: new Map(bound.map((one) => [one.file, one.module])),
              roots,
            }),
          });
          return pythonEntryReuse(
            previous.records,
            previous.plan.changed,
            changes,
          );
        });

  // Which wrappers the discovery being charged registered, so a replay of
  // its file can register the same ones in the same order.
  let registering: StoredRegistration[] | null = null;
  if (ledger !== null) {
    wrapperIndex.onRegistered = (target, how) => {
      const stored = storedRegistration(target, how, positions);
      if (registering !== null && stored !== null) {
        registering.push(stored);
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
        registerAgain(registration, {
          positions,
          wrapperIndex,
          target: storedFunction(registration, definitions, filesByPath),
        });
      }
      continue;
    }
    const storage = storageFor(boundFile);
    const discover = (): RawCodeStructure[] => [
      ...discoverUnits(root, moduleBinding, {
        packs: options.packs,
        filePath: displayPathOf(file),
        absoluteFile: file,
        routes,
        gapHandling,
        wrappers: wrapperIndex,
        importedDefinition,
        facts: db,
        tallies,
        ...(storage === undefined ? {} : { storage }),
      }),
      ...moduleExportUnits(boundFile, {
        modules: declaredModules,
        filesByPath,
        facts: db,
        storageFor,
      }),
      ...declaredDiscoveryUnits(boundFile, options.packs, {
        facts: db,
        storageFor,
        tallies,
      }),
      ...jobConsumerUnits(boundFile, { facts: db, storageFor }),
      ...(tests === null
        ? []
        : tests.unitsIn(boundFile, { storageFor, facts: db })),
    ];
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
    const { file, root } = boundFile;
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
            charged(file, () => stdlibReads(root, db).map((one) => one.effect)),
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
      ...(tests === null ? {} : { tests }),
    }),
  );
  // Where the functions the body at `key` calls are declared. The walk read
  // the lambdas written in that body too, so a claimed one is placed this way.
  const placeCallees = (summary: BehavioralSummary, key: string): void => {
    placeCalls(summary, reached.targetsByKey.get(key));
    placeArgTargets(summary, reached.argTargetsByKey.get(key));
    placePossibleCalls(summary, reached.possibleTargetsByKey.get(key));
    placeReceivers(summary, reached.receiversByKey.get(key));
  };
  const placeWhatItReached = (
    summary: BehavioralSummary,
    key: string,
  ): void => {
    if (gapHandling !== "silent") {
      summary.gaps.push(
        ...(reached.stopsByKey.get(key) ?? []).map(unfollowedCallGap),
      );
    }
    placeCallees(summary, key);
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
    placeWhatItReached(summary, key);
    summaries.push(summary);
    modules.set(boundFile.file, {
      seedKey: key,
      summary: ledger === null ? summary : structuredClone(summary),
    });
  }

  summaries.push(...reached.summaries);
  if (subUnits !== null) {
    const boundByDisplayPath = new Map(
      bound.map((one) => [one.displayPath, one]),
    );
    const claimed = timer.time("summarize", () =>
      subUnits.summariesFor(summaries, {
        boundFileOf: (displayPath) => boundByDisplayPath.get(displayPath),
        storageFor,
        gapHandling,
      }),
    );
    for (const { summary, parentKey } of claimed) {
      placeCallees(summary, parentKey);
      summaries.push(summary);
    }
  }
  summaries.push(
    ...libraryEnvReadMarkers(
      options.packs,
      (prefix) =>
        bound.find((file) => importsModule(file, prefix))?.displayPath,
    ),
  );

  // An under-question given up on its budget depends on how much the run
  // asked before it, which a replay changes, so such a run starts over.
  const spend = underQuestionSpend(db);
  const overBudget = spend.abandoned + spend.skipped > 0;
  if (overBudget && reuse !== null) {
    throw new ReplayFailed("");
  }

  const resolvedImports = importedFilesByFile(db, displayPathOf);
  stampModuleImports(summaries, (file) => resolvedImports.get(file) ?? []);
  stampModules(summaries, declaredModules, options.workspaceRoot);

  for (const summary of summaries) {
    const absoluteFile =
      options.workspaceRoot === undefined
        ? summary.location.file
        : path.resolve(options.workspaceRoot, summary.location.file);
    summary.identity.id = summaryIdFromParts({
      workspace: undefined,
      file:
        summaryRoot === undefined
          ? absoluteFile
          : path.relative(summaryRoot, absoluteFile),
      name: summary.identity.name,
      exportPath: summary.identity.exportPath,
    });
  }
  disambiguateSummaryIds(summaries);
  linkCallsToSummaries(summaries);
  const composed = timer.time("summarize", () => {
    // Before the cache write and over every summary, reused ones included:
    // only a run with every file unchanged serves the stored marks.
    markExitCodeFunctions(summaries, exits, db, options.workspaceRoot);
    return composeWrappers(summaries, { gapHandling });
  });

  const walkedFiles = new Map(
    bound.map(({ file, displayPath }) => [displayPath, file]),
  );
  await timer.timeAsync("cache.write", async () => {
    // An empty result is never cached. Serving one would skip the
    // stages that fill the funnel, so a misconfigured project would
    // get "0 summaries" with no explanation ever after.
    if (cacheDir === null || summaries.length === 0) {
      return;
    }
    try {
      await cache.layer.write(
        cache.input,
        summaries,
        log === null || ledger === null || overBudget
          ? undefined
          : pythonAttribution({
              summaries,
              walkedFileOf: (locationFile) => walkedFiles.get(locationFile),
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
                factsKeptFrom(options.files, previous?.plan ?? null),
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

/** Whether the file imports, at module level, a module that starts with the prefix. */
function importsModule(file: BoundPythonFile, prefix: string): boolean {
  for (const binding of file.module.moduleScope.bindings.values()) {
    if (
      (binding.kind === "import" || binding.kind === "importFrom") &&
      binding.relativeLevel === 0 &&
      binding.module.startsWith(prefix)
    ) {
      return true;
    }
  }
  return false;
}

/** A registration as a cache entry writes it, or null when the run's packs cannot place it. */
function storedRegistration(
  target: ReachedFunction,
  how: FormOf | DecoratorClosure,
  positions: PackPositions,
): StoredRegistration | null {
  const at = {
    key: nodeId(target.file.file, target.node),
    name: target.name,
    exportPath: target.exportPath,
  };
  if ("continuation" in how) {
    const pattern = positions.idOf(how.pattern);
    return pattern === undefined
      ? null
      : { ...at, pattern, continuation: how.continuation };
  }
  const form = positions.positionOf(how);
  return form === undefined ? null : { ...at, form };
}

/** Registers a stored wrapper again, the way the discovery that stored it did. */
function registerAgain(
  registration: StoredRegistration,
  context: {
    positions: PackPositions;
    wrapperIndex: PythonWrapperIndex;
    target: ReachedFunction | null;
  },
): void {
  const { positions, wrapperIndex, target } = context;
  const how = howRegistered(registration, positions);
  if (target === null || how === null) {
    throw new ReplayFailed(registration.key);
  }
  if ("continuation" in how) {
    wrapperIndex.registeredClosure(target, how);
    return;
  }
  wrapperIndex.registered(target, how);
}

/** What a stored registration was registered through, or null when this run's packs no longer have it. */
function howRegistered(
  registration: StoredRegistration,
  positions: PackPositions,
): FormOf | DecoratorClosure | null {
  if (!("continuation" in registration)) {
    return positions.formAt(registration.form) ?? null;
  }
  const pack = positions.packOf(registration.pattern);
  const pattern = positions.patternOf(registration.pattern);
  return pack === undefined || pattern === undefined
    ? null
    : { pack, pattern, continuation: registration.continuation };
}

/** Every file's record for the entry this run writes. */
function pythonAttribution(args: {
  /** What the entry stores: every summary, before wrappers are composed. */
  summaries: readonly BehavioralSummary[];
  walkedFileOf: (locationFile: string) => string | undefined;
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
  return {
    roots,
    owners: ownersWhereWritten(args.summaries, args.walkedFileOf),
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
  for (const child of children(node)) {
    if (child !== null) {
      indexDefinitions(into, file, child);
    }
  }
}
