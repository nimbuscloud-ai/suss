/**
 * Runs the Ruby adapter over a project: discovers units, emits summaries
 * in the shared IR, and emits facts.
 *
 * It parses every file it is given, emits the run's facts into one
 * shared `Database`, runs discovery over each file, walks what each unit
 * reaches, and hands every unit to `assembleSummary` from
 * `@suss/extractor`. The Python and TypeScript adapters use the same
 * assembly step, so gap detection is shared across all three languages.
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

import { rangeOf } from "./ast.js";
import { readDynamicNames } from "./defineMethod.js";
import {
  buildRubyExtractionReport,
  createPackTallies,
  tallyUnit,
} from "./diagnostics.js";
import { createFileCache, discoverUnits, routingGapUnit } from "./discovery.js";
import { emitEnvFacts, envReadEffects } from "./envReads.js";
import { callbacksIn, emitClassCallbacks } from "./facts/callbacks.js";
import {
  collectFileConstants,
  emitConstantBindings,
  type FileConstants,
} from "./facts/constants.js";
import { emitValueFacts, nodeId } from "./facts/values.js";
import { emitRequireFacts } from "./facts.js";
import { bodyBlocksIn, inflectionsIn } from "./pack.js";
import { parseRuby } from "./parser.js";
import {
  EVERY_ARGLESS_CALL,
  moduleScopeInvocationEffects,
} from "./paths/effects.js";
import { dropPropertyReads, reachedFunctions } from "./reach/closure.js";
import { buildReachContext } from "./reach/context.js";
import { walkDefinitions } from "./scope.js";
import { bindEvaluator, methodDefinitionsIn } from "./values/evaluator.js";
import { adapterStamp } from "./version.js";

import type { BehavioralSummary, Effect } from "@suss/behavioral-ir";
import type {
  CacheDiagnostic,
  CacheInput,
  CacheLayer,
  ExtractionReport,
  ExtractorOptions,
  RawCodeStructure,
  RawEffect,
  TimingReport,
} from "@suss/extractor";
import type { BodyBlocks, Range } from "./ast.js";
import type { ReachSeed } from "./discovery.js";
import type { RbAssociationCalls, RbInflections, RubyPack } from "./pack.js";
import type { RbNode } from "./parser.js";
import type { Seed } from "./reach/closure.js";
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

/**
 * An entry for the summary list, added once the walk has run: either a
 * unit still to assemble, with the seed key the walk finishes its effect
 * list from, or a summary that was complete when it was built.
 */
type Discovered =
  | {
      readonly raw: RawCodeStructure;
      readonly seedKey: string | null;
      /** Set for a unit to report only when the walk reached a project method from it. */
      readonly onlyIfItReaches?: boolean;
    }
  | { readonly summary: BehavioralSummary };

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
 * Whether an earlier file's discovery already reported this unit. Units
 * are compared by where the body is written, the name it is reported
 * under, and the boundary it reaches. The boundary is part of the key
 * because one body can be several units: an action two controllers
 * inherit, or a client call that reaches a different route under each
 * construction of its class.
 */
function alreadyDiscovered(seen: Set<string>, raw: RawCodeStructure): boolean {
  const reported = raw.identity.exportPath?.join(".") ?? raw.identity.name;
  const boundary =
    raw.boundaryBinding === null
      ? ""
      : (boundaryKey(raw.boundaryBinding) ?? "");
  const key = `${raw.identity.file}::${reported}::${raw.identity.range.start}::${boundary}`;
  if (seen.has(key)) {
    return true;
  }
  seen.add(key);
  return false;
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
  const extractionCache: CacheLayer = createCacheLayer(cacheDir);
  const packsDigest = adapterStamp.packsDigest(
    options.packs.map((pack) =>
      pack.version !== undefined
        ? { name: pack.name, version: pack.version }
        : { name: pack.name },
    ),
  );
  const cacheInput: CacheInput = {
    files: cacheDir === null ? [] : options.files,
    adapterPacksDigest:
      cacheDir === null
        ? packsDigest
        : runDigest(packsDigest, options.packs, options.files),
  };
  const lookup = await timer.timeAsync("cache.lookup", () =>
    extractionCache.lookup(cacheInput),
  );
  options.onCacheDiagnostic?.(lookup.diagnostic);
  if (lookup.kind === "hit") {
    options.onTiming?.(timer.report());
    return { summaries: lookup.summaries, facts: new Database() };
  }

  const db = new Database();
  const summaries: BehavioralSummary[] = [];
  const tallies = createPackTallies(options.packs);
  // One cache for the run, so a class that is both an input file and the
  // target of a wiring keyword is parsed once.
  const cache = createFileCache(
    (source) => parseRuby(source).then((tree) => tree.rootNode),
    (absPath) =>
      fs.existsSync(absPath) ? fs.readFileSync(absPath, "utf8") : null,
  );

  // Facts are emitted for every file before discovery starts, because the
  // storage recognizer asks during discovery which file defines a constant.
  const facts = new RunFacts(db, options.packs);
  const { parsed, bodyBlocks } = facts;
  for (const file of options.files) {
    await timer.timeAsync("parse", async () => {
      const root = await cache.get(file);
      if (root !== null) {
        facts.addFile(file, root);
      }
    });
  }
  const dynamicNames = timer.time("discover", () => {
    facts.finish();
    return readDynamicNames(
      db,
      new Map(parsed.map(({ file, root }) => [file, root])),
    );
  });

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
  const reachContext = await timer.timeAsync("discover", () =>
    buildReachContext(parsed, db, bodyBlocks, dynamicNames, loaderPatterns),
  );
  // Facts keep the absolute path because they are joined on it. Only a
  // summary's `location.file` is shortened.
  const displayPathOf = (file: string): string =>
    options.workspaceRoot !== undefined
      ? path.relative(options.workspaceRoot, file)
      : file;

  const seeds: Seed[] = [];
  const seedKeys = new Set<string>();
  const summariesBySeed = new Map<string, BehavioralSummary[]>();
  const discovered = new Set<string>();
  // Units are assembled after the walk, in discovery order, because a body's
  // effect list is not final until the walk decides which of its
  // no-argument calls are property reads.
  const found: Discovered[] = [];

  for (const { file, root } of parsed) {
    const displayPath = displayPathOf(file);

    // A unit whose body is a method, such as a graphql-ruby field's
    // resolver, reports that method here as a starting point for the walk.
    const seedByRaw = new Map<RawCodeStructure, ReachSeed>();
    const rawUnits = await timer.timeAsync("discover", () =>
      discoverUnits(root, {
        packs: options.packs,
        filePath: displayPath,
        absoluteFile: file,
        cache,
        ...(storage === undefined ? {} : { storage }),
        inheritedMethods,
        bodyBlocks,
        dynamicNames,
        displayPathOf,
        facts: db,
        onReachSeed: (raw, seed) => seedByRaw.set(raw, seed),
      }),
    );
    for (const raw of rawUnits) {
      // A filter on a base class is discovered again for every controller
      // that inherits it, but it is one method and gets one summary.
      if (alreadyDiscovered(discovered, raw)) {
        continue;
      }
      tallyUnit(tallies, raw.boundaryBinding?.recognition);

      const seed = seedByRaw.get(raw);
      if (seed === undefined) {
        found.push({ raw, seedKey: null });
        continue;
      }
      const key = nodeId(seed.file, seed.node);
      found.push({ raw, seedKey: key });
      if (!seedKeys.has(key)) {
        seedKeys.add(key);
        seeds.push({
          key,
          file: seed.file,
          node: seed.node,
          enclosingQualifiedName: seed.enclosingQualifiedName,
        });
      }
    }

    // A file's top-level statements run when it loads, so they are a seed
    // for the walk like any method.
    const moduleKey = nodeId(file, root);
    seedKeys.add(moduleKey);
    seeds.push({
      key: moduleKey,
      file,
      node: root,
      enclosingQualifiedName: null,
    });

    const loadTime = timer.time("discover", () => ({
      reads: envReadEffects(root, { db, file }),
      calls: moduleScopeInvocationEffects(
        root,
        inheritedMethods,
        EVERY_ARGLESS_CALL,
        db,
      ),
    }));
    found.push({
      raw: moduleInitUnit({
        name: path.basename(displayPath),
        file: displayPath,
        range: rangeOf(root),
        effects: loadTime.reads,
        calls: loadTime.calls,
      }),
      seedKey: moduleKey,
      onlyIfItReaches: loadTime.reads.length === 0,
    });
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
        assembleSummary(routingGapUnit(pattern, gaps), {
          gapHandling: "permissive",
        }),
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
      dynamicNames,
    }),
  );
  for (const entry of found) {
    if ("summary" in entry) {
      summaries.push(entry.summary);
      continue;
    }
    const { raw, seedKey } = entry;
    if (
      entry.onlyIfItReaches === true &&
      (seedKey === null || !reached.followedKeys.has(seedKey))
    ) {
      continue;
    }
    if (seedKey !== null) {
      dropPropertyReads(raw, reached.propertyReadsByKey.get(seedKey));
    }
    const summary = timer.time("summarize", () =>
      assembleSummary(raw, { gapHandling: "permissive" }),
    );
    // `assembleSummary` scores confidence as if every branch came from
    // tracing the body, which is not true of every unit here.
    summary.confidence = { source: "inferred_static", level: "low" };
    summaries.push(summary);
    if (seedKey !== null) {
      summariesBySeed.set(seedKey, [
        ...(summariesBySeed.get(seedKey) ?? []),
        summary,
      ]);
    }
  }

  for (const [key, owners] of summariesBySeed) {
    for (const summary of owners) {
      summary.gaps.push(
        ...(reached.stopsByKey.get(key) ?? []).map(unfollowedCallGap),
      );
      placeCalls(summary, reached.targetsByKey.get(key));
      placeArgTargets(summary, reached.argTargetsByKey.get(key));
      placeCalleeParameters(summary, reached.parameterCallsByKey.get(key));
    }
  }
  recordParameterGaps(
    reached.parameterCallsByKey,
    summariesBySeed,
    reached.passedPositions,
  );
  summaries.push(...reached.summaries);

  // Ruby has no import statement, so a file's dependencies are the
  // `require_relative` lines and the constants other files in the run define.
  const dependencies = importedFilesByFile(db, displayPathOf);
  stampModuleImports(summaries, (file) => dependencies.get(file) ?? []);

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
  const composed = timer.time("summarize", () =>
    composeWrappers(summaries, {
      gapHandling: options.gapHandling ?? "permissive",
    }),
  );

  await timer.timeAsync("cache.write", async () => {
    // An empty result is not cached. A cache hit skips the stages that
    // explain an empty run, so a misconfigured project would keep getting
    // "0 summaries" with no reason given.
    if (cacheDir === null || composed.length === 0) {
      return;
    }
    try {
      await extractionCache.write(cacheInput, composed);
    } catch {
      // A failed cache write must not fail the extract.
    }
  });

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
