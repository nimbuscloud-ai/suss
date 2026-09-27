/**
 * Runs the Ruby adapter over a project: discovers units, emits summaries
 * in the shared IR, and emits facts.
 *
 * It parses every file it is given, emits the run's facts into one
 * shared `Database`, runs discovery over each file, walks what each unit
 * reaches, and hands every unit to `assembleSummary` from
 * `@suss/extractor`. The Python and TypeScript adapters use the same
 * assembly step, so gap detection is shared across all three languages.
 * With a cache, a run after an edit replays the files and methods whose
 * inputs did not change, through the records in `reuse.ts`.
 */

import fs from "node:fs";
import path from "node:path";

import {
  boundaryKey,
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
  extractionConfigStamp,
  KeptParses,
  moduleInitStructure,
  noopTimer,
  runDigest,
  stampModuleImports,
  stampModules,
} from "@suss/extractor";
import {
  addPackWords,
  DependencyLedger,
  FactLog,
  hashString,
  importedFilesByFile,
  mergeStoredDependencies,
  noDependencies,
  nodeOfKey,
  observeDemand,
  type PackWords,
  recordsToReplay,
  underQuestionSpend,
  walkRecordsByFile,
} from "@suss/resolution";

import { rangeOf } from "./ast.js";
import { readDynamicNames } from "./defineMethod.js";
import {
  buildRubyExtractionReport,
  createPackTallies,
  tallyUnit,
} from "./diagnostics.js";
import { createFileCache, discoverUnits, routingGapUnit } from "./discovery.js";
import {
  emitEnvFacts,
  envReadEffects,
  settleNamedParameters,
} from "./envReads.js";
import { exitSites, markExitCodeFunctions } from "./exits.js";
import { callbacksIn, emitClassCallbacks } from "./facts/callbacks.js";
import {
  collectFileConstants,
  emitConstantBindings,
  type FileConstants,
} from "./facts/constants.js";
import { emitValueFacts, nodeId } from "./facts/values.js";
import { emitRequireFacts } from "./facts.js";
import { moduleExportUnits, settleRubyModules } from "./moduleSurface.js";
import { bodyBlocksIn, inflectionsIn } from "./pack.js";
import { parseRuby } from "./parser.js";
import {
  EVERY_ARGLESS_CALL,
  moduleScopeInvocationEffects,
} from "./paths/effects.js";
import { bindRequestAccessors } from "./provenance.js";
import {
  dropPropertyReads,
  ReplayFailed,
  reachedFunctions,
} from "./reach/closure.js";
import { buildReachContext } from "./reach/context.js";
import {
  lookAgainIn,
  rubyEntryReuse,
  WalkReplay,
  watchDynamicNames,
  watchFileCache,
  watchReachContext,
} from "./reuse.js";
import { walkDefinitions } from "./scope.js";
import {
  bindEvaluator,
  forgetEvaluations,
  methodDefinitionsIn,
} from "./values/evaluator.js";
import { adapterStamp } from "./version.js";

import type { BehavioralSummary, Effect } from "@suss/behavioral-ir";
import type {
  CacheAttribution,
  CacheDiagnostic,
  CacheInput,
  CacheLayer,
  DeclaredModule,
  ExtractionReport,
  ExtractorOptions,
  PartialPlan,
  RawCodeStructure,
  RawEffect,
  Timer,
  TimingReport,
} from "@suss/extractor";
import type {
  Changes,
  StoredDependencies,
  StoredFacts,
} from "@suss/resolution";
import type { BodyBlocks, Range } from "./ast.js";
import type { ReachSeed } from "./discovery.js";
import type { RbAssociationCalls, RbInflections, RubyPack } from "./pack.js";
import type { RbNode } from "./parser.js";
import type { ReachedUnits, Seed } from "./reach/closure.js";
import type {
  RubyEntryReuse,
  RubyFileRecord,
  StoredModule,
  StoredSeed,
  StoredUnit,
} from "./reuse.js";
import type { EvaluatedFile } from "./values/evaluator.js";

export interface ExtractRubyOptions {
  /** Absolute paths of the files to parse and extract. */
  files: string[];
  packs: RubyPack[];
  /** When set, `location.file` on each summary is relativized against this. */
  workspaceRoot?: string;
  /** The directory a summary's id measures its file from, when that differs from `workspaceRoot`. */
  projectRoot?: string;
  /** Called once with the run's per-phase wall time, for `suss extract --timing`. */
  onTiming?: (report: TimingReport) => void;
  /** Called once with the file-by-file funnel, for `suss extract --explain`. */
  onExtractionReport?: (report: ExtractionReport) => void;
  /** Called once with what the cache decided, for `suss extract --timing`. */
  onCacheDiagnostic?: (diagnostic: CacheDiagnostic) => void;
  /** Absolute. `<projectRoot>/.suss/cache` by default; `null` turns it off. */
  cacheDir?: string | null;
  /** How to handle gaps. Composing a controller's filters into its actions can add one. */
  gapHandling?: ExtractorOptions["gapHandling"];
  /** The modules the project lists in `suss.json`, with absolute paths. */
  modules?: readonly DeclaredModule[];
  /** Parses an earlier run in this process left, for a file whose text is unchanged. */
  keptParses?: KeptRubyParses;
}

export type KeptRubyParses = KeptParses<RbNode>;

/** A holder for parses between runs, which frees each tree it lets go of. */
export function keptRubyParses(): KeptRubyParses {
  return new KeptParses((root) => root.tree.delete());
}

/**
 * Parses these files into `kept` before any run needs them. A run served
 * whole from the cache parses nothing, so a process that keeps parses
 * calls this while nobody is waiting.
 */
export async function parseRubyAhead(
  files: readonly string[],
  kept: KeptRubyParses,
): Promise<void> {
  for (const file of files) {
    await kept.parse(file, fs.readFileSync(file, "utf8"), parseRubyRoot);
  }
  kept.keepOnly(files);
}

async function parseRubyRoot(source: string): Promise<RbNode> {
  return (await parseRuby(source)).rootNode;
}

export interface ExtractRubyResult {
  summaries: BehavioralSummary[];
  facts: Database;
}

/**
 * Every method the run's packs declare their libraries define, pooled
 * across packs. There is one pool for the run because the reach walk also
 * reads methods no pattern discovered, and has to leave these out there too.
 */
function inheritedMethodsIn(packs: readonly RubyPack[]): ReadonlySet<string> {
  const found = new Set<string>();
  for (const pack of packs) {
    for (const pattern of pack.discovery) {
      if (pattern.type !== "controllerActions") {
        continue;
      }
      for (const name of pattern.inheritedMethodNames ?? []) {
        found.add(name);
      }
    }
  }
  return found;
}

/**
 * The association calls every storage pattern in the run declares. The
 * constants pass reads model bodies with these, because the target class
 * of an association is resolved there.
 */
export function associationCallsIn(
  packs: readonly RubyPack[],
): RbAssociationCalls[] {
  return packs.flatMap((pack) =>
    (pack.storage ?? []).flatMap((pattern) =>
      pattern.associations === undefined ? [] : [pattern.associations],
    ),
  );
}

/**
 * The run's pack declarations in the form `addPackWords` takes. Ruby code
 * declares no return types, so a storage pattern's `givesBack` methods are
 * the only source for knowing that `Account.find(id)` returns an Account.
 */
export function packWordsOf(packs: readonly RubyPack[]): PackWords {
  return {
    givesBackOne: packs.flatMap((pack) =>
      (pack.storage ?? []).flatMap((pattern) =>
        pattern.baseClasses.flatMap((base) =>
          pattern.givesBack.map((method) => ({ base, method })),
        ),
      ),
    ),
    unwrapsByName: packs.flatMap((pack) => pack.transparentWrappers ?? []),
  };
}

/**
 * The facts a run emits over its files under its packs. Each file's own
 * facts go in as the file is parsed, and `finish` adds the facts that
 * join files once every file is in. The extract run, `factsForFile` and
 * the why session all emit through this, so a summary and a why answer
 * about the same code are read from the same facts.
 */
export class RunFacts {
  readonly db: Database;
  readonly parsed: EvaluatedFile[] = [];
  readonly bodyBlocks: BodyBlocks;
  private readonly packs: readonly RubyPack[];
  private readonly associationCalls: RbAssociationCalls[];
  private readonly inflections: RbInflections;
  private readonly definitions = new Map<string, RbNode>();
  private readonly constants: FileConstants[] = [];

  constructor(db: Database, packs: readonly RubyPack[]) {
    this.db = db;
    this.packs = packs;
    this.bodyBlocks = bodyBlocksIn(packs);
    this.associationCalls = associationCallsIn(packs);
    this.inflections = inflectionsIn(packs);
  }

  addFile(file: string, root: RbNode): void {
    this.parsed.push({ file, root });
    emitValueFacts(this.db, file, root, this.bodyBlocks);
    emitEnvFacts(this.db, file, root);
    for (const [key, method] of methodDefinitionsIn(file, root)) {
      this.definitions.set(key, method);
    }
    this.constants.push(
      collectFileConstants(file, root, this.associationCalls, this.inflections),
    );
  }

  /** Which file defines a constant is only known once every file is in, so references are bound here. */
  finish(): void {
    emitConstantBindings(this.db, this.constants);
    const known = new Set(this.parsed.map(({ file }) => file));
    for (const { file, root } of this.parsed) {
      emitRequireFacts(this.db, file, root, known);
    }
    bindEvaluator(this.db, {
      files: this.parsed,
      definitions: this.definitions,
    });
    bindRequestAccessors(
      this.db,
      this.packs.flatMap((pack) => pack.requestAccessors ?? []),
    );
    addPackWords(this.db, packWordsOf(this.packs));
    const callbacks = callbacksIn(
      this.packs.flatMap((pack) => pack.storage ?? []),
    );
    for (const { file, root } of this.parsed) {
      walkDefinitions(root, (info) =>
        emitClassCallbacks(this.db, file, info.node, callbacks),
      );
    }
  }
}

/** One parsed file and the packs a run over it would load. */
export interface FileFactsOptions {
  file: string;
  root: RbNode;
  packs: readonly RubyPack[];
}

/**
 * The facts for a single parsed file, with the evaluator bound to them,
 * for a caller with one file and no project, such as a pack's tests. The
 * rules need facts to work out what built a receiver. A project run emits
 * the same facts for every file at once, so a name defined in another
 * file resolves there but not here.
 */
export function factsForFile(options: FileFactsOptions): Database {
  const facts = new RunFacts(new Database(), options.packs);
  facts.addFile(options.file, options.root);
  facts.finish();
  return facts.db;
}

/** A unit's record while the run that will store it is still going. */
type UnitDraft = { -readonly [K in keyof StoredUnit]: StoredUnit[K] };

/** A file's load-time unit's record while the run is still going. */
type ModuleDraft = { -readonly [K in keyof StoredModule]: StoredModule[K] };

/**
 * An entry for the summary list, added once the walk has run: a unit
 * still to assemble, with the seed key the walk finishes its effect list
 * from; a summary that was complete when it was built; or a summary an
 * earlier run stored, already assembled and placed.
 */
type Discovered =
  | {
      readonly raw: RawCodeStructure;
      readonly seedKey: string | null;
      /** Set for a unit to report only when the walk reached a project method from it. */
      readonly onlyIfItReaches?: boolean;
      /** The record to fill in with the finished summary, when a cache is recording. */
      readonly draft?: UnitDraft | ModuleDraft;
    }
  | { readonly summary: BehavioralSummary }
  | {
      readonly replayed: BehavioralSummary | null;
      readonly seedKey: string | null;
      readonly onlyIfItReaches?: boolean;
    };

/** What a file does as it loads. The calls go on the branch, as a reached method's do, so the walk can place them. */
function moduleInitUnit(options: {
  name: string;
  file: string;
  range: Range;
  effects: Effect[];
  calls: RawEffect[];
}): RawCodeStructure {
  const raw = moduleInitStructure({
    name: options.name,
    file: options.file,
    range: options.range,
    effects: options.effects,
  });
  const branch = raw.branches[0];
  if (branch !== undefined) {
    branch.effects = options.calls;
  }
  return raw;
}

/**
 * What tells a unit apart from one an earlier file's discovery already
 * reported: where the body is written, the name it is reported under,
 * and the boundary it reaches. The boundary is part of it because one
 * body can be several units: an action two controllers inherit, or a
 * client call that reaches a different route under each construction of
 * its class.
 */
function discoveredAs(raw: RawCodeStructure): string {
  const reported = raw.identity.exportPath?.join(".") ?? raw.identity.name;
  const boundary =
    raw.boundaryBinding === null
      ? ""
      : (boundaryKey(raw.boundaryBinding) ?? "");
  return `${raw.identity.file}::${reported}::${raw.identity.range.start}::${boundary}`;
}

/**
 * Whether replaying a file's stored units drops the same duplicates the
 * stored run dropped. A unit that run dropped as a duplicate and that no
 * earlier file claims this time has no stored summary, so the file is
 * discovered again instead.
 */
function replaysCleanly(
  units: readonly StoredUnit[],
  discovered: ReadonlySet<string>,
): boolean {
  const seen = new Set<string>();
  for (const unit of units) {
    const duplicate = discovered.has(unit.dedup) || seen.has(unit.dedup);
    if (!unit.kept && !duplicate) {
      return false;
    }
    if (!duplicate) {
      seen.add(unit.dedup);
    }
  }
  return true;
}

/** The cache a run reads and writes, set up once for the run. */
interface RunCache {
  readonly timer: Timer;
  readonly cacheDir: string | null;
  readonly layer: CacheLayer<RubyFileRecord>;
  readonly input: CacheInput;
}

/** An earlier run's entry, when this run can replay parts of it. */
interface Previous {
  readonly plan: PartialPlan<RubyFileRecord>;
  readonly records: ReadonlyMap<string, RubyFileRecord>;
}

export async function extractRubyProject(
  options: ExtractRubyOptions,
): Promise<ExtractRubyResult> {
  const timer = options.onTiming !== undefined ? createTimer() : noopTimer();

  const cacheDir = adapterStamp.declineWhenRunFromSource(
    options.cacheDir === null
      ? null
      : (options.cacheDir ??
          (options.projectRoot !== undefined
            ? path.join(options.projectRoot, ".suss", "cache")
            : null)),
  );
  const layer = createCacheLayer<RubyFileRecord>(cacheDir);
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
    modules: settleRubyModules(options.modules),
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
    return { summaries: lookup.summaries, facts: new Database() };
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
    return { summaries: plan.allSummaries(), facts: new Database() };
  }

  const cache: RunCache = { timer, cacheDir, layer, input };
  const records =
    plan === null
      ? null
      : recordsToReplay<RubyFileRecord>(plan.roots, plan.changed, plan.removed);
  if (plan !== null && records !== null) {
    try {
      return await runRuby(options, cache, { plan, records });
    } catch (error) {
      if (!(error instanceof ReplayFailed)) {
        throw error;
      }
    }
  }
  options.onCacheDiagnostic?.(lookup.diagnostic);
  return runRuby(options, cache, null);
}

/** A stored seed with its node found again in this run's trees. */
function seedFromStored(
  seed: StoredSeed,
  nodeOf: (key: string) => RbNode | null,
): Seed {
  const node = nodeOf(seed.key);
  if (node === null) {
    throw new ReplayFailed(seed.key);
  }
  return {
    key: seed.key,
    file: seed.file,
    node,
    enclosingQualifiedName: seed.enclosingQualifiedName,
  };
}

function addForSeed(
  bySeed: Map<string, BehavioralSummary[]>,
  seedKey: string,
  summary: BehavioralSummary,
): void {
  bySeed.set(seedKey, [...(bySeed.get(seedKey) ?? []), summary]);
}

async function runRuby(
  options: ExtractRubyOptions,
  cache: RunCache,
  previous: Previous | null,
): Promise<ExtractRubyResult> {
  const { timer, cacheDir } = cache;
  const db = new Database();
  const summaries: BehavioralSummary[] = [];
  const gapHandling = options.gapHandling ?? "permissive";
  const tallies = createPackTallies(options.packs);
  // With a cache, every question and every read of another file is charged
  // to the file's discovery or the method's scan that made it.
  const ledger = cacheDir === null ? null : new DependencyLedger(options.files);
  const log = ledger === null ? null : new FactLog(db, ledger);
  if (ledger !== null) {
    observeDemand(db, ledger);
  }
  // One cache for the run, so a class that is both an input file and the
  // target of a wiring keyword is parsed once.
  const parses = options.keptParses ?? keptRubyParses();
  const trees = createFileCache(
    (source, absPath) => parses.parse(absPath, source, parseRubyRoot),
    (absPath) =>
      fs.existsSync(absPath) ? fs.readFileSync(absPath, "utf8") : null,
  );
  const fileCache = ledger === null ? trees : watchFileCache(trees, ledger);

  // Facts are emitted for every file before discovery starts, because the
  // storage recognizer asks during discovery which file defines a constant.
  const facts = new RunFacts(db, options.packs);
  const { parsed, bodyBlocks } = facts;
  for (const file of options.files) {
    await timer.timeAsync("parse", async () => {
      const root = await trees.get(file);
      if (root !== null) {
        log?.startFile();
        facts.addFile(file, root);
        log?.endFile(file);
      }
    });
  }
  // A file read later in the run for its constants is parsed through the
  // same holder, so letting go of the rest now frees only last run's trees.
  options.keptParses?.keepOnly(options.files);
  const rootsByFile = new Map(parsed.map(({ file, root }) => [file, root]));
  const dynamicNames = timer.time("discover", () => {
    log?.startJoined();
    facts.finish();
    const names = readDynamicNames(db, rootsByFile);
    if (ledger !== null) {
      settleNamedParameters(db);
    }
    log?.endJoined();
    return names;
  });
  const watchedNames =
    ledger === null ? dynamicNames : watchDynamicNames(dynamicNames, db);

  const storagePatterns = options.packs.flatMap((pack) => pack.storage ?? []);
  const loaderPatterns = options.packs.flatMap((pack) => pack.loaders ?? []);
  const rawSqlPatterns = options.packs.flatMap((pack) => pack.rawSql ?? []);
  const storage =
    storagePatterns.length > 0 || rawSqlPatterns.length > 0
      ? {
          facts: db,
          patterns: storagePatterns,
          loaders: loaderPatterns,
          rawSql: rawSqlPatterns,
        }
      : undefined;
  const inheritedMethods = inheritedMethodsIn(options.packs);
  const declaredModules = settleRubyModules(options.modules);
  const plainContext = await timer.timeAsync("discover", () =>
    buildReachContext(parsed, db, bodyBlocks, watchedNames, loaderPatterns),
  );
  const reachContext =
    ledger === null ? plainContext : watchReachContext(plainContext);
  // Facts keep the absolute path because they are joined on it. Only a
  // summary's `location.file` is shortened.
  const displayPathOf = (file: string): string =>
    options.workspaceRoot !== undefined
      ? path.relative(options.workspaceRoot, file)
      : file;

  const reuse =
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
            lookAgain: lookAgainIn(plainContext, dynamicNames),
          };
          return rubyEntryReuse(previous.records, changedFiles, changes);
        });
  const nodeOf = (key: string): RbNode | null => nodeOfKey(rootsByFile, key);

  const seeds: Seed[] = [];
  const seedKeys = new Set<string>();
  const summariesBySeed = new Map<string, BehavioralSummary[]>();
  const discovered = new Set<string>();
  // Units are assembled after the walk, in discovery order, because a body's
  // effect list is not final until the walk decides which of its
  // no-argument calls are property reads.
  const found: Discovered[] = [];
  const discoveries = new Map<string, FileDiscovery>();

  for (const { file, root } of parsed) {
    const displayPath = displayPathOf(file);
    // A file's top-level statements run when it loads, so they are a seed
    // for the walk like any method.
    const moduleKey = nodeId(file, root);
    const moduleSeed: Seed = {
      key: moduleKey,
      file,
      node: root,
      enclosingQualifiedName: null,
    };

    const record = reuse?.discoveryOf(file);
    if (record !== undefined && replaysCleanly(record.units, discovered)) {
      discoveries.set(file, record);
      for (const unit of record.units) {
        if (discovered.has(unit.dedup)) {
          continue;
        }
        discovered.add(unit.dedup);
        tallyUnit(tallies, unit.recognition);
        found.push({
          replayed: unit.summary ?? null,
          seedKey: unit.seed?.key ?? null,
        });
        if (unit.seed !== undefined && !seedKeys.has(unit.seed.key)) {
          seedKeys.add(unit.seed.key);
          seeds.push(seedFromStored(unit.seed, nodeOf));
        }
      }
      seedKeys.add(moduleKey);
      seeds.push(moduleSeed);
      found.push({
        replayed: record.module.summary,
        seedKey: moduleKey,
        onlyIfItReaches: record.module.onlyIfItReaches,
      });
      continue;
    }

    const charge = noDependencies();
    // A unit whose body is a method, such as a graphql-ruby field's
    // resolver, reports that method here as a starting point for the walk.
    const seedByRaw = new Map<RawCodeStructure, ReachSeed>();
    const onReachSeed = (raw: RawCodeStructure, seed: ReachSeed): void => {
      seedByRaw.set(raw, seed);
    };
    const discover = async (): Promise<RawCodeStructure[]> => [
      ...(await discoverUnits(root, {
        packs: options.packs,
        filePath: displayPath,
        absoluteFile: file,
        cache: fileCache,
        ...(storage === undefined ? {} : { storage }),
        inheritedMethods,
        bodyBlocks,
        dynamicNames: watchedNames,
        displayPathOf,
        facts: db,
        onReachSeed,
      })),
      ...moduleExportUnits(root, file, {
        modules: declaredModules,
        ...(storage === undefined ? {} : { storage }),
        inheritedMethods,
        bodyBlocks,
        dynamicNames: watchedNames,
        displayPathOf,
        facts: db,
        onReachSeed,
      }),
    ];
    const rawUnits = await timer.timeAsync("discover", () =>
      ledger === null
        ? discover()
        : ledger.chargingAsync(charge, () => {
            forgetEvaluations(db);
            ledger.readFile(file);
            return discover();
          }),
    );
    const units: UnitDraft[] = [];
    for (const raw of rawUnits) {
      const dedup = discoveredAs(raw);
      const duplicate = discovered.has(dedup);
      const seed = seedByRaw.get(raw);
      const seedKey = seed === undefined ? null : nodeId(seed.file, seed.node);
      const recognition = raw.boundaryBinding?.recognition;
      units.push({
        dedup,
        kept: !duplicate,
        ...(recognition === undefined ? {} : { recognition }),
        ...(seed === undefined || seedKey === null
          ? {}
          : {
              seed: {
                key: seedKey,
                file: seed.file,
                enclosingQualifiedName: seed.enclosingQualifiedName,
              },
            }),
      });
      // A filter on a base class is discovered again for every controller
      // that inherits it, but it is one method and gets one summary.
      if (duplicate) {
        continue;
      }
      discovered.add(dedup);
      tallyUnit(tallies, recognition);
      found.push({ raw, seedKey, draft: units[units.length - 1] });
      if (seed !== undefined && seedKey !== null && !seedKeys.has(seedKey)) {
        seedKeys.add(seedKey);
        seeds.push({
          key: seedKey,
          file: seed.file,
          node: seed.node,
          enclosingQualifiedName: seed.enclosingQualifiedName,
        });
      }
    }

    seedKeys.add(moduleKey);
    seeds.push(moduleSeed);
    const readLoadTime = () => ({
      reads: envReadEffects(root, { db, file }),
      calls: moduleScopeInvocationEffects(
        root,
        inheritedMethods,
        EVERY_ARGLESS_CALL,
        db,
      ),
    });
    const loadTime = timer.time("discover", () =>
      ledger === null ? readLoadTime() : ledger.charging(charge, readLoadTime),
    );
    const moduleDraft: ModuleDraft = {
      seedKey: moduleKey,
      summary: null,
      onlyIfItReaches: loadTime.reads.length === 0,
    };
    found.push({
      raw: moduleInitUnit({
        name: path.basename(displayPath),
        file: displayPath,
        range: rangeOf(root),
        effects: loadTime.reads,
        calls: loadTime.calls,
      }),
      seedKey: moduleKey,
      onlyIfItReaches: moduleDraft.onlyIfItReaches,
      draft: moduleDraft,
    });
    if (ledger !== null) {
      discoveries.set(file, {
        discovery: ledger.store(charge),
        units,
        module: moduleDraft,
      });
    }
  }

  // One gap unit per controllerActions pattern with routing it could not
  // read, built once here instead of once per controller.
  for (const pack of options.packs) {
    for (const pattern of pack.discovery) {
      if (pattern.type !== "controllerActions") {
        continue;
      }
      const gaps = pattern.routingGaps?.() ?? [];
      if (gaps.length === 0) {
        continue;
      }
      const summary = timer.time("summarize", () =>
        assembleSummary(routingGapUnit(pattern, gaps), { gapHandling }),
      );
      summary.confidence = { source: "inferred_static", level: "low" };
      found.push({ summary });
    }
  }

  const reached = await timer.timeAsync("summarize", () =>
    reachedFunctions(seeds, {
      context: reachContext,
      displayPathOf,
      ...(storage === undefined ? {} : { storage }),
      inheritedMethods,
      bodyBlocks,
      dynamicNames: watchedNames,
      gapHandling,
      ...(reuse === null ? {} : { replay: new WalkReplay(reuse, rootsByFile) }),
      ...(ledger === null ? {} : { ledger }),
    }),
  );
  const assembledHere = new Set<BehavioralSummary>();
  const toStore: {
    summary: BehavioralSummary;
    draft: UnitDraft | ModuleDraft;
  }[] = [];
  let summariesReused = 0;
  for (const entry of found) {
    if ("summary" in entry) {
      summaries.push(entry.summary);
      continue;
    }
    const { seedKey } = entry;
    if (
      entry.onlyIfItReaches === true &&
      (seedKey === null || !reached.followedKeys.has(seedKey))
    ) {
      continue;
    }
    if ("replayed" in entry) {
      if (entry.replayed === null) {
        throw new ReplayFailed(seedKey ?? "");
      }
      const summary = structuredClone(entry.replayed);
      summariesReused += 1;
      summaries.push(summary);
      if (seedKey !== null) {
        addForSeed(summariesBySeed, seedKey, summary);
      }
      continue;
    }
    const { raw } = entry;
    if (seedKey !== null) {
      dropPropertyReads(raw, reached.propertyReadsByKey.get(seedKey));
    }
    const summary = timer.time("summarize", () =>
      assembleSummary(raw, { gapHandling }),
    );
    // `assembleSummary` scores confidence as if every branch came from
    // tracing the body, which is not true of every unit here.
    summary.confidence = { source: "inferred_static", level: "low" };
    summaries.push(summary);
    assembledHere.add(summary);
    if (entry.draft !== undefined) {
      toStore.push({ summary, draft: entry.draft });
    }
    if (seedKey !== null) {
      addForSeed(summariesBySeed, seedKey, summary);
    }
  }

  for (const [key, owners] of summariesBySeed) {
    for (const summary of owners) {
      // A replayed summary was placed by the run that stored it.
      if (!assembledHere.has(summary)) {
        continue;
      }
      if (gapHandling !== "silent") {
        summary.gaps.push(
          ...(reached.stopsByKey.get(key) ?? []).map(unfollowedCallGap),
        );
      }
      placeCalls(summary, reached.targetsByKey.get(key));
      placeArgTargets(summary, reached.argTargetsByKey.get(key));
      placeCalleeParameters(summary, reached.parameterCallsByKey.get(key));
    }
  }
  if (ledger !== null) {
    for (const { summary, draft } of toStore) {
      draft.summary = structuredClone(summary);
    }
  }
  if (gapHandling !== "silent") {
    recordParameterGaps(
      reached.parameterCallsByKey,
      summariesBySeed,
      reached.passedPositions,
    );
  }
  summaries.push(...reached.summaries);

  // An under-question given up on its budget depends on how much the run
  // asked before it, which a replay changes, so such a run starts over.
  const spend = underQuestionSpend(db);
  const overBudget = spend.abandoned + spend.skipped > 0;
  if (overBudget && reuse !== null) {
    throw new ReplayFailed("");
  }

  // Ruby has no import statement, so a file's dependencies are the
  // `require_relative` lines and the constants other files in the run define.
  const dependencies = importedFilesByFile(db, displayPathOf);
  stampModuleImports(summaries, (file) => dependencies.get(file) ?? []);
  stampModules(summaries, declaredModules, options.workspaceRoot);

  // Ids use paths relative to the project root, because the CLI later
  // shortens `location.file` to that root and the two have to match.
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
  const composed = timer.time("summarize", () => {
    // Before the cache write and over every summary, reused ones included:
    // only a run with every file unchanged serves the stored marks.
    markExitCodeFunctions(
      summaries,
      parsed.map(({ file, root }) => ({ file, sites: exitSites(root) })),
      db,
      options.workspaceRoot,
    );
    return composeWrappers(summaries, { gapHandling });
  });

  await timer.timeAsync("cache.write", async () => {
    // An empty result is not cached. A cache hit skips the stages that
    // explain an empty run, so a misconfigured project would keep getting
    // "0 summaries" with no reason given.
    if (cacheDir === null || composed.length === 0) {
      return;
    }
    try {
      await cache.layer.write(
        cache.input,
        composed,
        log === null || ledger === null || overBudget
          ? undefined
          : rubyAttribution({
              composed,
              discoveries,
              reached,
              reuse,
              ledger,
              facts: log.stored(
                parsed.map(({ file }) => file),
                new Map(
                  [...(previous?.records ?? [])].map(([file, record]) => [
                    file,
                    record.facts,
                  ]),
                ),
                new Set(
                  previous === null
                    ? []
                    : parsed
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
    const filesReplayed = parsed.filter(
      ({ file }) => discoveries.get(file) === reuse.records.get(file),
    ).length;
    options.onCacheDiagnostic?.({
      kind: "partial",
      partial: {
        filesChanged: previous.plan.changed.size,
        filesRemoved: 0,
        rootsReused: filesReplayed,
        rootsReextracted: parsed.length - filesReplayed,
        rootsDeclined: 0,
        summariesReused: summariesReused + libraryReused,
      },
    });
  }

  options.onExtractionReport?.(
    buildRubyExtractionReport({
      packs: options.packs,
      tallies,
      filesWalked: options.files.length,
      summaries: composed,
    }),
  );
  options.onTiming?.(timer.report());

  return { summaries: composed, facts: db };
}

/** What one file's discovery found and depended on, replayed or done in this run. */
interface FileDiscovery {
  readonly discovery: StoredDependencies;
  readonly units: readonly StoredUnit[];
  readonly module: StoredModule;
}

/** Every file's record for the entry this run writes. */
function rubyAttribution(args: {
  composed: readonly BehavioralSummary[];
  discoveries: ReadonlyMap<string, FileDiscovery>;
  reached: ReachedUnits;
  reuse: RubyEntryReuse | null;
  facts: ReadonlyMap<string, StoredFacts>;
  ledger: DependencyLedger;
}): CacheAttribution<RubyFileRecord> {
  const walkedByFile = walkRecordsByFile({
    scans: args.reached.scans,
    charges: args.reached.charges,
    beforeGaps: args.reached.beforeGaps,
    replayed: (key) => args.reuse?.walkOf(key),
    store: (dependencies) => args.ledger.store(dependencies),
    merge: mergeStoredDependencies,
  });

  const roots = [...args.discoveries].map(([file, found]) => ({
    path: file,
    cacheable: true,
    deps: [],
    claims: [],
    packs: [],
    meta: {
      discovery: found.discovery,
      units: found.units,
      module: found.module,
      walked: walkedByFile.get(file) ?? [],
      facts: args.facts.get(file) ?? { own: "", joined: "" },
    },
  }));
  return { roots, owners: args.composed.map(() => []) };
}

const SKIPPED_DIRECTORIES = new Set(["vendor", "node_modules", "tmp", ".git"]);

/** Every `.rb` file under `root`, sorted, skipping vendored, temporary and VCS directories. */
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
