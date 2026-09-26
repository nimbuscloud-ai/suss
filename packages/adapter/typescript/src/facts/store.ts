/**
 * The resolution store, and the questions callers ask it.
 *
 * `resolveCallable` says which function a value comes down to, through
 * any depth of aliasing, imports, re-export barrels, wrapper factories
 * and `.bind`. `resolveWrittenValue` says which expression a value is
 * written as, for callers chasing something that is neither a function
 * nor an object. `argumentsPassedTo` and `callsPassing` go from a
 * parameter to the calls that filled it, or the ones it hands to.
 * `filesImportingTransitively` says which of a set of files reach any
 * of a set of packages, which a per-file import check misses whenever a
 * local barrel re-exports the SDK.
 */

import { Node } from "ts-morph";

import {
  clearRelations,
  Database,
  evaluate,
  type OnDemandRules,
  proofOf,
  tupleKey,
  tupleKeyParts,
  witnesses,
} from "@suss/datalog";
import {
  ASKING_RELATIONS,
  addPackWords,
  allocationSitesOf,
  askResolutionUnder,
  type ExplainStats,
  fallbackWrittenAs,
  proofRules,
  queryFacts,
  RESOLUTION_QUESTIONS,
  resolutionProgram,
  resolutionUnderProgram,
  RESOLUTION_RULES as SHARED_RULES,
  withoutOverridden,
  writtenValueUnder,
} from "@suss/resolution";

import { sourceFileFor } from "../bootstrap/sourceFileLookup.js";
import { recordFileDependency } from "../depTracking.js";
import { isFunctionRoot } from "../discovery/shared.js";
import {
  createNodeTable,
  emitValue,
  environmentObjectsIn,
  extractFileFacts,
  factKeyOf,
  importedModuleKeys,
  type NodeTable,
  nodeId,
  packagesDeclaring,
} from "./extract.js";
import {
  LANGUAGE_RECEIVER_RETURNS,
  LANGUAGE_WRAPPERS,
} from "./languageWords.js";
import {
  type FileSetQuery,
  ModuleGraph,
  namesAnyPackage,
} from "./moduleGraph.js";

import type { Atom, Proof } from "@suss/datalog";
import type { PatternPack, TransparentWrapper } from "@suss/extractor";
import type { Project, SourceFile } from "ts-morph";

const RESOLUTION_PROGRAM: OnDemandRules = resolutionProgram();

/**
 * What a why-question re-evaluates: the rules as written, with no
 * demand transform. Witnesses must record the original rules, and
 * `deriveOnDemand` refuses algebras, so the proof pass is exhaustive
 * over the base facts the demand walk extracted.
 */
const WITNESS_RULES = proofRules(SHARED_RULES);

/** Every relation some variant of the program derives, or asks with. */
const NOT_BASE_FACTS = new Set([
  ...[...SHARED_RULES, ...RESOLUTION_QUESTIONS].map((r) => r.head.relation),
  ...RESOLUTION_PROGRAM.rules.map((r) => r.head.relation),
  ...ASKING_RELATIONS,
]);

type Question =
  | "wanted"
  | "wantedOrigin"
  | "wantedCallOrigin"
  | "wantedAnchor"
  | "wantedSites"
  | "wantedEnvObject"
  | "wantedSubject";

/**
 * Dropped once a query's result has been read, so the next query does
 * not re-derive over every question asked before it. The answer
 * relations stay, and a repeated query reads its result from those.
 */
const QUERY_FACTS: readonly string[] = queryFacts(RESOLUTION_PROGRAM);

/**
 * A rule consults another module through its export table, so a demand
 * on `moduleExport` or `moduleForwards` with the module column bound is
 * the rules saying which file they need next. The module is the first
 * column of the relation, so it is the first column of the demand row.
 */
const MODULE_DEMANDS: readonly string[] = RESOLUTION_PROGRAM.demands
  .filter(
    (one) =>
      (one.relation === "moduleExport" || one.relation === "moduleForwards") &&
      one.bound[0] === true,
  )
  .map((one) => one.demand);

export interface ExplainCallableOptions {
  /** A second file to walk out from; see `resolveCallable`. */
  alsoFrom?: SourceFile;
  /** How many derived nodes deep the proof walk goes; see `proofOf`. */
  maxDepth?: number;
}

export interface ExplainedResolution {
  /** The node the value comes down to. */
  target: Node;
  proof: Proof;
  /** The source node behind a proof atom, when the atom is a node id. */
  nodeFor: (atom: Atom) => Node | undefined;
  stats: ExplainStats;
}

/** One call of a function, and what it wrote at one parameter. */
export interface PassedArgument {
  call: Node;
  argument: Node;
}

/** See `ResolutionStore.envNamers`. */
export interface EnvironmentNamers {
  /**
   * The environment reads that take their variable's name from this
   * parameter, however many helpers forward it along the way. Empty for
   * a parameter no read ever takes a name from, and null where the
   * rules had nothing to go on: a file that exports nothing states no
   * facts, so their silence about its parameters means neither yes nor
   * no, and the asker settles what it can by reading the syntax.
   */
  sitesNaming(parameter: Node): readonly Node[] | null;
}

/** What every parameter gets in a project with no environment read to follow. */
const NO_NAMERS: EnvironmentNamers = { sitesNaming: () => [] };

/** What the store works out once about where the environment goes. */
interface EnvironmentAnswers {
  namers: EnvironmentNamers;
  /** Parameters some caller hands the environment object to, by fact key. */
  receivers: ReadonlySet<string>;
}

/** One round of the environment question, before it settles. */
interface EnvironmentAsked {
  byParameter: Map<string, Node[]>;
  receivers: Set<string>;
  /** Calls that hand the environment object to something, by fact key. */
  passingCalls: string[];
}

export class ResolutionStore {
  private readonly db = new Database();
  private readonly table: NodeTable;
  private readonly fullyExtracted = new Set<string>();
  private readonly seededValues = new Set<string>();
  private readonly importedNames = new Map<
    string,
    { names: string[]; walked: string[] }
  >();
  private readonly writtenValues = new Map<
    string,
    { written: Node | null; walked: string[]; extractedAt: number }
  >();
  private readonly importOrigins = new Map<
    string,
    {
      origins: Array<{ module: string; path: string[] }>;
      walked: string[];
      extractedAt: number;
    }
  >();
  private readonly subjectConstructions = new Map<
    string,
    {
      construction: Node | null;
      /**
       * How many constructions the walk reached. Two or more is why
       * `construction` is null, and the caller says so rather than
       * dropping the registration without a word.
       */
      candidates: number;
      walked: string[];
      extractedAt: number;
    }
  >();
  /**
   * A file's table depends only on its re-export closure, which
   * `collectExports` extracts whole before answering, so later
   * extraction elsewhere cannot change an entry.
   */
  private readonly exportTables = new Map<string, Map<string, Node[]>>();
  /** Keyed by value and site both, since one value differs per site. */
  private readonly writtenUnderSite = new Map<string, Node | null>();
  private readonly constructionSites = new Map<string, string[]>();
  /** Files the most recent query read, for the memo to keep. */
  private lastQueryWalked: string[] = [];
  /** See `environmentSiteFiles`; null until the first env question. */
  private envSiteFiles: readonly SourceFile[] | null = null;
  /** See `environmentAnswers`; null until the first env question. */
  private envAnswers: EnvironmentAnswers | null = null;
  private readonly declarations = new Map<Node, Node>();
  private readonly graph = new ModuleGraph();
  /** See `notePossibleCallers`. */
  private readonly possibleCallers = new Set<SourceFile>();
  private readonly callerFilesRead = new Set<string>();

  private stale = true;

  constructor(
    wrappers: TransparentWrapper[] = [],
    environmentObjects: readonly string[] = [],
  ) {
    this.table = createNodeTable(environmentObjects);
    addPackWords(this.db, {
      unwrapsByName: [...LANGUAGE_WRAPPERS, ...wrappers],
      returnsReceiver: LANGUAGE_RECEIVER_RETURNS,
    });
  }

  /** A store with the wrappers and environment objects these packs declare, as an extraction over them starts from. */
  static forPacks(packs: readonly PatternPack[]): ResolutionStore {
    return new ResolutionStore(
      packs.flatMap((pack) => pack.transparentWrappers ?? []),
      packs.flatMap((pack) => pack.environmentObjects ?? []),
    );
  }

  /**
   * `alsoFrom` is a second file to walk out from, for a caller that
   * knows where the value it is asking about was set up. The walk
   * follows imports outward from the value's own file, so a file that
   * imports it, and passed something to the constructor, is somewhere
   * the walk never reaches on its own.
   */
  resolveCallable(value: Node, alsoFrom?: SourceFile): Node | null {
    const sources = this.resolveCallableSources(value, alsoFrom);
    const only = sources[0];
    return sources.length === 1 && only !== undefined ? only : null;
  }

  /**
   * Every function the value comes down to. One is the answer
   * `resolveCallable` gives; several is a value with more than one
   * possible source, which a caller says at the site rather than
   * folding into the same nothing as a chain that went nowhere.
   */
  resolveCallableSources(value: Node, alsoFrom?: SourceFile): Node[] {
    const target = factKeyOf(value);
    return this.askAbout(
      target,
      "wanted",
      () => this.lookupSources(target),
      alsoFrom,
    );
  }

  /**
   * The witness proof behind `resolveCallable`'s answer. Resolves the
   * value first, which extracts the files the question demands, then
   * re-evaluates the rules over those base facts under the witness
   * algebra and rebuilds the proof of the answer. Null when the value
   * does not resolve at all.
   */
  explainCallable(
    value: Node,
    options: ExplainCallableOptions = {},
  ): ExplainedResolution | null {
    const resolved = this.resolveCallable(value, options.alsoFrom);
    if (resolved === null) {
      return null;
    }

    const proofDb = new Database();
    let baseFacts = 0;
    for (const relation of this.db.relationNames()) {
      if (NOT_BASE_FACTS.has(relation)) {
        continue;
      }
      for (const tuple of this.db.facts(relation)) {
        proofDb.add(relation, tuple);
        baseFacts++;
      }
    }

    const started = performance.now();
    evaluate(proofDb, WITNESS_RULES, witnesses);
    const evaluateMs = performance.now() - started;
    const derivedFacts =
      proofDb
        .relationNames()
        .reduce((count, relation) => count + proofDb.size(relation), 0) -
      baseFacts;

    const proof = proofOf(
      proofDb,
      "resolves",
      [nodeId(factKeyOf(value)), nodeId(resolved)],
      options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth },
    );
    return {
      target: resolved,
      proof,
      nodeFor: (atom) => this.table.byId.get(String(atom)),
      stats: { baseFacts, derivedFacts, evaluateMs },
    };
  }

  resolveObject(value: Node): Node | null {
    const target = factKeyOf(value);
    return this.askAbout(target, "wanted", () => this.lookupObject(target));
  }

  /**
   * The function a call returns: `app.use(requireCaller(config))`
   * registers what the factory gives back. A separate question from
   * `resolveCallable`, which keeps a call unresolved on purpose so an
   * unwrapping answer wins; this one is asked only after that has
   * declined. Two returned functions give null, like every other
   * single-answer question here.
   */
  resolveReturnedCallable(call: Node): Node | null {
    const target = factKeyOf(call);
    return this.askAbout(target, "wanted", () => this.lookupReturned(target));
  }

  /**
   * The function a call through this value runs: the one it comes down
   * to, and failing that the one it gives back, so a name written as
   * `useNavigator()` runs what that factory returned. Both answers come
   * from the same derivation, so asking them together costs one query.
   */
  resolveCalledFunction(value: Node): Node | null {
    return this.resolveCalledFunctions([value]).get(value) ?? null;
  }

  /**
   * The batched form, for a caller with a body's worth of callees: one
   * demand set and one derivation shared by all of them, where asking
   * each alone re-derives once per value.
   */
  resolveCalledFunctions(values: readonly Node[]): Map<Node, Node | null> {
    const targets = values.map((value) => ({
      value,
      target: factKeyOf(value),
    }));
    try {
      for (const { target } of targets) {
        this.wantValue("wanted", target);
        this.seedValue(target);
      }
      this.extractDemanded([
        ...new Set(targets.map(({ target }) => target.getSourceFile())),
      ]);
      const found = new Map<Node, Node | null>();
      for (const { value, target } of targets) {
        found.set(value, this.calledFunctionOf(target));
      }
      return found;
    } finally {
      this.forgetQuery();
    }
  }

  private calledFunctionOf(target: Node): Node | null {
    const sources = this.lookupSources(target);
    const only = sources[0];
    if (sources.length === 1 && only !== undefined) {
      return only;
    }
    return this.lookupReturned(target);
  }

  /**
   * For a value that is neither a function nor an object, such as a
   * GraphQL document kept in a constant in another file.
   */
  resolveWrittenValue(value: Node): Node | null {
    const target = factKeyOf(value);
    const key = nodeId(this.sharedDeclarationFor(target));
    const cached = this.writtenValues.get(key);
    // A cached answer stays true as facts accumulate; a cached miss
    // was true of a smaller fact set, so it is recomputed once the
    // store has extracted more files than it had then.
    if (
      cached !== undefined &&
      (cached.written !== null ||
        cached.extractedAt === this.fullyExtracted.size)
    ) {
      // A memo hit walks nothing, but whoever is collecting file
      // dependencies still read those files through it.
      for (const walkedPath of cached.walked) {
        recordFileDependency(walkedPath);
      }
      return cached.written;
    }

    const written = this.askAbout(target, "wanted", () =>
      this.lookupWritten(target),
    );
    this.writtenValues.set(key, {
      written,
      walked: [...this.lastQueryWalked],
      extractedAt: this.fullyExtracted.size,
    });
    return written;
  }

  /**
   * The same question under one construction site: what the value is
   * when the receiver behind it is the instance that site made. A field
   * two constructions fill differently settles here and not context
   * free, where two answers are ambiguity.
   */
  resolveWrittenValueUnder(value: Node, site: string): Node | null {
    const target = factKeyOf(value);
    const key = nodeId(target);
    const cached = this.writtenUnderSite.get(`${key}|${site}`);
    if (cached !== undefined) {
      return cached;
    }

    // The value's own file has to be read before the question, the way
    // `askAbout` reads it, and the under program runs over everything
    // the store already has rather than following its own demand.
    this.askAbout(target, "wanted", () => undefined);
    const outcome = askResolutionUnder(
      this.db,
      [[key, site]],
      resolutionUnderProgram(),
    );
    // The under program cleared what the context-free one had derived.
    this.stale = true;
    // A question nobody could finish is cached as no answer, so a second
    // caller asking about the same pair does not start the walk again.
    if (outcome === "abandoned") {
      this.writtenUnderSite.set(`${key}|${site}`, null);
      return null;
    }

    const answer = writtenValueUnder(this.db, key, site, (pairs) => {
      askResolutionUnder(this.db, pairs, resolutionUnderProgram());
    });
    const node = answer === null ? null : (this.table.byId.get(answer) ?? null);
    const written =
      node === null || node === target || !Node.isExpression(node)
        ? null
        : node;
    this.writtenUnderSite.set(`${key}|${site}`, written);
    return written;
  }

  /**
   * Every construction of this class the run can see, as fact keys, for
   * a caller about to ask a value question under each. A class nothing
   * constructs has none.
   */
  constructionSitesOf(cls: Node): string[] {
    const key = nodeId(cls);
    const cached = this.constructionSites.get(key);
    if (cached !== undefined) {
      return cached;
    }
    this.readPossibleCallersOf(cls.getSourceFile());
    const sites = this.askAbout(cls, "wantedSites", () => {
      this.derive();
      return allocationSitesOf(this.db, key);
    });
    this.constructionSites.set(key, sites);
    return sites;
  }

  /**
   * Every call of the function this parameter belongs to, with the
   * argument that call wrote at it, as the caller wrote it. The reading
   * is left to the asker, who knows what kind of value it is after.
   *
   * The callers are in files that import the parameter's own, so they
   * are read into the store first; no query starting at the parameter
   * arrives at them.
   */
  argumentsPassedTo(parameter: Node): PassedArgument[] {
    this.readPossibleCallersOf(parameter.getSourceFile());
    return this.askAbout(parameter, "wanted", () => {
      this.derive();
      const found: PassedArgument[] = [];
      for (const pair of this.answerPairsFor(
        "wantedPassesArgument",
        nodeId(parameter),
      )) {
        const [callId = "", argumentId = ""] = tupleKeyParts(pair);
        const call = this.table.byId.get(callId);
        const argument = this.table.byId.get(argumentId);
        if (call !== undefined && argument !== undefined) {
          found.push({ call, argument });
        }
      }
      return found;
    });
  }

  /**
   * The other direction from `argumentsPassedTo`: every call in this
   * parameter's own function, or a closure nested inside it, that hands
   * the parameter to something else. `callArg` keeps the argument as a
   * bare reference, so the join is against `binds` rather than the
   * parameter's own key; a reference only binds to a parameter in scope
   * where it is written, which already keeps the answer inside the
   * parameter's own function with no join against `bodyCalls` needed.
   */
  callsPassing(parameter: Node): PassedArgument[] {
    this.extractFile(parameter.getSourceFile());
    const found: PassedArgument[] = [];
    for (const [referenceId] of this.db.lookup("binds", 1, nodeId(parameter))) {
      const reference = String(referenceId);
      for (const passed of this.db.lookup("callArg", 2, reference)) {
        const call = this.table.byId.get(String(passed[0]));
        const argument = this.table.byId.get(reference);
        if (call !== undefined && argument !== undefined) {
          found.push({ call, argument });
        }
      }
    }
    return found;
  }

  /**
   * Whether this expression's value is the environment object: the way
   * a pack spells it, a name declared as that, or a parameter some
   * caller hands one to, however many calls deep.
   *
   * A parameter's answer depends on its callers, so it comes from the
   * parameters the environment reaches, worked out once per run.
   */
  isEnvironmentValue(value: Node): boolean {
    const target = factKeyOf(value);
    const first = this.askAbout(target, "wanted", () => {
      this.derive();
      return {
        environment: this.hasAnswer("wantedEnvironmentValue", target),
        parameters: this.answersFor("wantedRefersToParam", nodeId(target)),
      };
    });
    if (first.environment || first.parameters.length === 0) {
      return first.environment;
    }
    const { receivers } = this.environmentAnswers(target.getProject());
    return first.parameters.some((parameter) => receivers.has(parameter));
  }

  private hasAnswer(relation: string, target: Node): boolean {
    return this.answersFor(relation, nodeId(target)).length > 0;
  }

  /**
   * Which parameters an environment read takes its variable's name
   * from, for a reader standing at a call. One question covers the
   * whole project: a project has a handful of environment reads and
   * thousands of parameters, and with the read bound the rules run from
   * each callee to its callers. The facts README says which files that
   * reads and why it is asked once.
   */
  envNamers(project: Project): EnvironmentNamers {
    return this.environmentAnswers(project).namers;
  }

  private environmentAnswers(project: Project): EnvironmentAnswers {
    if (this.envAnswers !== null) {
      return this.envAnswers;
    }
    const siteFiles = this.environmentSiteFiles(project);
    if (siteFiles.length === 0) {
      this.envAnswers = { namers: NO_NAMERS, receivers: new Set() };
      return this.envAnswers;
    }

    // Every file reaching a forwarder reaches the helper it forwards to,
    // so reading the helpers' callers covers every hop at once. A helper
    // a factory builds turns up only once the environment is followed.
    const helpers = this.followEnvironment(siteFiles).byParameter;
    for (const helperFile of this.filesOf(helpers)) {
      this.readPossibleCallersOf(helperFile);
    }
    const { byParameter, receivers } = this.followEnvironment(siteFiles);
    const siteFilePaths = new Set(siteFiles.map((one) => one.getFilePath()));
    this.envAnswers = {
      namers: {
        sitesNaming: (parameter: Node) =>
          this.sitesNamedBy(byParameter, siteFilePaths, parameter),
      },
      receivers,
    };
    return this.envAnswers;
  }

  /**
   * Ask until every call handing the environment on has had its callee
   * read, one hop a round, so the answer covers each parameter it lands in.
   */
  private followEnvironment(seeds: readonly SourceFile[]): EnvironmentAsked {
    const followed = new Set<string>();
    for (;;) {
      const asked = this.askEnvironment(seeds);
      const next = asked.passingCalls.filter((call) => !followed.has(call));
      if (next.length === 0) {
        return asked;
      }
      for (const callId of next) {
        followed.add(callId);
        this.readCalleeOf(callId);
      }
    }
  }

  private readCalleeOf(callId: string): void {
    const call = this.table.byId.get(callId);
    if (
      call !== undefined &&
      (Node.isCallExpression(call) || Node.isNewExpression(call))
    ) {
      this.resolveCallableSources(call.getExpression());
    }
  }

  /** The files the parameters an answer is keyed by are declared in. */
  private filesOf(byParameter: ReadonlyMap<string, Node[]>): Set<SourceFile> {
    const files = new Set<SourceFile>();
    for (const parameterId of byParameter.keys()) {
      const parameter = this.table.byId.get(parameterId);
      if (parameter !== undefined) {
        files.add(parameter.getSourceFile());
      }
    }
    return files;
  }

  private sitesNamedBy(
    answered: ReadonlyMap<string, Node[]>,
    siteFilePaths: ReadonlySet<string>,
    parameter: Node,
  ): readonly Node[] | null {
    const key = nodeId(parameter);
    const sites = answered.get(key);
    if (sites !== undefined) {
      return sites;
    }
    if (!siteFilePaths.has(parameter.getSourceFile().getFilePath())) {
      return [];
    }
    return this.db.lookup("paramOf", 2, key).length > 0 ? [] : null;
  }

  /**
   * Seed every expression that spells the environment, derive, and take
   * back the read sites per parameter and the parameters the object is
   * handed to. The question is dropped afterwards, so a later ask over a
   * larger fact set derives it again.
   *
   * The reads themselves cannot be the seed: one written through a
   * parameter is off an object a scan of the source has no way to pick
   * out, and the whole point of asking is to find those.
   */
  private askEnvironment(seeds: readonly SourceFile[]): EnvironmentAsked {
    const byParameter = new Map<string, Node[]>();
    const receivers = new Set<string>();
    const passingCalls: string[] = [];
    try {
      for (const [object] of this.db.facts("environmentObject")) {
        this.wantKey("wantedEnvObject", String(object));
      }
      this.extractDemanded(seeds);
      this.derive();
      for (const [parameter, site] of this.db.facts("wantedParamNamesEnv")) {
        const node = this.table.byId.get(String(site));
        if (node === undefined) {
          continue;
        }
        const sites = byParameter.get(String(parameter)) ?? [];
        sites.push(node);
        byParameter.set(String(parameter), sites);
      }
      for (const [parameter] of this.db.facts("wantedEnvParameter")) {
        receivers.add(String(parameter));
      }
      for (const [call] of this.db.facts("wantedEnvPassingCall")) {
        passingCalls.push(String(call));
      }
    } finally {
      this.forgetQuery();
    }
    return { byParameter, receivers, passingCalls };
  }

  /**
   * The project's files that hand the environment object somewhere,
   * read into the store. Which files those are cannot depend on what a
   * reader happened to ask about first, so the scan is over the
   * project's own sources and it happens once.
   */
  private environmentSiteFiles(project: Project): readonly SourceFile[] {
    if (this.envSiteFiles !== null) {
      return this.envSiteFiles;
    }
    const found = project
      .getSourceFiles()
      .filter(
        (one) =>
          !one.isInNodeModules() &&
          environmentObjectsIn(this.table, one).length > 0,
      );
    this.envSiteFiles = found;
    this.extractFiles(found);
    return found;
  }

  /**
   * Whether running this function hands back that call: returned
   * outright, written into a name and returned, or a shorthand body.
   * A call whose own callee the rules cannot follow is not, which is
   * what keeps a wrapper's own result apart from the library's.
   */
  returnsCall(func: Node, call: Node): boolean {
    const target = factKeyOf(func);
    const handedBack = nodeId(factKeyOf(call));
    return this.askAbout(target, "wanted", () => {
      this.derive();
      return this.answersFor("wantedReturnsCall", nodeId(target)).includes(
        handedBack,
      );
    });
  }

  /**
   * Files a later question about a parameter may find a caller in.
   * Without this the search falls back to every file the project has
   * loaded, which reads more of the import graph than a run needs.
   */
  notePossibleCallers(sourceFiles: Iterable<SourceFile>): void {
    for (const sourceFile of sourceFiles) {
      this.possibleCallers.add(sourceFile);
    }
  }

  private readPossibleCallersOf(target: SourceFile): void {
    const targetPath = target.getFilePath();
    if (this.callerFilesRead.has(targetPath)) {
      return;
    }
    this.callerFilesRead.add(targetPath);
    const candidates = [...this.callerCandidates(target)].filter(
      (one) => one !== target,
    );
    if (candidates.length === 0) {
      return;
    }
    const [reaching] = this.graph.filesReachingFile([
      { sourceFiles: candidates, target },
    ]);
    this.extractFiles(reaching ?? []);
  }

  private callerCandidates(target: SourceFile): Iterable<SourceFile> {
    if (this.possibleCallers.size > 0) {
      return this.possibleCallers;
    }
    return target
      .getProject()
      .getSourceFiles()
      .filter((one) => !one.isInNodeModules());
  }

  /**
   * The construction behind a registration subject: the call or `new`
   * this value is written as, kept only when its callee comes from
   * `importModule` under `importName`. A value written as two
   * different things comes back null, since keying a route on the
   * wrong app is worse than not keying it.
   */
  subjectConstructionOf(
    value: Node,
    importModule: string,
    importName: string,
  ): Node | null {
    const target = factKeyOf(value);
    const shared = nodeId(this.sharedDeclarationFor(target));
    const key = `subject|${shared}|${importModule}|${importName}`;
    const cached = this.subjectConstructions.get(key);
    // A cached answer stays true as facts accumulate; a cached miss
    // was true of a smaller fact set, so it is recomputed once the
    // store has extracted more files than it had then.
    if (
      cached !== undefined &&
      (cached.construction !== null ||
        cached.extractedAt === this.fullyExtracted.size)
    ) {
      // A memo hit walks nothing, but whoever is collecting file
      // dependencies still read those files through it.
      for (const walkedPath of cached.walked) {
        recordFileDependency(walkedPath);
      }
      return cached.construction;
    }

    const settled = this.askAbout(target, "wantedSubject", () =>
      this.lookupSubjectConstruction(target, importModule, importName),
    );
    const walked = [...this.lastQueryWalked];

    // The rule that unwraps a call's return fires only for a call asked
    // about directly, so a candidate that is itself a project function's
    // call gets a second, separate query with the call as the subject.
    let resolved = settled;
    if (
      settled.construction === null &&
      settled.candidate !== null &&
      Node.isCallExpression(settled.candidate) &&
      this.resolveCallable(settled.candidate.getExpression()) !== null
    ) {
      const call = settled.candidate;
      resolved = this.askAbout(call, "wantedSubject", () =>
        this.lookupSubjectConstruction(call, importModule, importName),
      );
      walked.push(...this.lastQueryWalked);
    }

    this.subjectConstructions.set(key, {
      construction: resolved.construction,
      candidates: resolved.candidates,
      walked,
      extractedAt: this.fullyExtracted.size,
    });
    return resolved.construction;
  }

  /**
   * How many constructions this value was written as, which is what
   * `subjectConstructionOf` weighed before it declined. Ask it after
   * that call, so the walk it needs has already been paid for.
   */
  subjectCandidateCountOf(
    value: Node,
    importModule: string,
    importName: string,
  ): number {
    const shared = nodeId(this.sharedDeclarationFor(factKeyOf(value)));
    return (
      this.subjectConstructions.get(
        `subject|${shared}|${importModule}|${importName}`,
      )?.candidates ?? 0
    );
  }

  /**
   * The single-answer policy over the written-value chain, then the
   * origin check on the one candidate.
   */
  private lookupSubjectConstruction(
    value: Node,
    importModule: string,
    importName: string,
  ): { construction: Node | null; candidate: Node | null; candidates: number } {
    this.derive();

    const valueId = nodeId(value);
    const candidates = new Set<Node>();
    for (const target of this.answersFor("wantedSubjectWritten", valueId)) {
      const node = this.table.byId.get(target);
      if (node === undefined || node === value || !Node.isExpression(node)) {
        continue;
      }
      candidates.add(node);
    }

    // Counting only the ones this pack's own import built keeps a
    // parameter two callers hand two unrelated objects out of the
    // report, since neither of those is a routable.
    if (candidates.size > 1) {
      return {
        construction: null,
        candidate: null,
        candidates: [...candidates].filter((one) =>
          this.constructionComesFrom(valueId, one, importModule, importName),
        ).length,
      };
    }
    const single = [...candidates][0];
    if (single === undefined) {
      return { construction: null, candidate: null, candidates: 0 };
    }

    return {
      construction: this.constructionComesFrom(
        valueId,
        single,
        importModule,
        importName,
      )
        ? single
        : null,
      candidate: single,
      candidates: 1,
    };
  }

  /**
   * Whether the construction's callee was imported from this module
   * under this name. A default import records its name as "default",
   * and a pack declares a default export by the local name people
   * give it, so "default" counts when the callee is spelled with the
   * declared name.
   */
  private constructionComesFrom(
    valueId: string,
    construction: Node,
    importModule: string,
    importName: string,
  ): boolean {
    const constructionId = nodeId(construction);
    for (const tuple of this.db.lookup(
      "wantedSubjectConstruction",
      0,
      valueId,
    )) {
      if (String(tuple[1]) !== constructionId) {
        continue;
      }
      const module = String(tuple[2]);
      if (module !== importModule && !namesPackage(module, [importModule])) {
        continue;
      }
      const name = String(tuple[3]);
      if (name === importName) {
        return true;
      }
      if (
        name === "default" &&
        this.calleeTextOf(constructionId) === importName
      ) {
        return true;
      }
    }
    return false;
  }

  /** The callee of a call, as written. */
  private calleeTextOf(callId: string): string | null {
    const first = this.db.lookup("call", 0, callId)[0];
    const callee =
      first === undefined ? undefined : this.table.byId.get(String(first[1]));
    return callee === undefined ? null : callee.getText();
  }

  /**
   * Which names from `modules` this value comes down to, either by being
   * one of them under a local name or by calling into one. Getting
   * several back is normal, since a wrapper can compose two library
   * decorators.
   */
  importedNamesOf(value: Node, modules: string[]): string[] {
    let refersTo = this.declarations.get(value);
    if (refersTo === undefined) {
      refersTo = declarationOf(value);
      this.declarations.set(value, refersTo);
    }

    const declaration = `${nodeId(refersTo)}|${modules.join(",")}`;
    const cached = this.importedNames.get(declaration);
    if (cached !== undefined) {
      // A memo hit walks nothing, but whoever is collecting file
      // dependencies still read those files through it.
      for (const walkedPath of cached.walked) {
        recordFileDependency(walkedPath);
      }
      return cached.names;
    }
    const target = factKeyOf(value);
    const found = this.askAbout(target, "wantedOrigin", () =>
      this.lookupImportedNames(target, modules),
    );
    this.importedNames.set(declaration, {
      names: found,
      walked: [...this.lastQueryWalked],
    });
    return found;
  }

  /**
   * Which module export this value comes down to, with what made it
   * included: a value written as `createClient()` is made from the
   * module exporting `createClient`, and a member destructured off
   * that result is one path segment further. The module half is the
   * specifier as the source wrote it, so a subpath import keeps its
   * subpath.
   */
  importOriginsOf(
    value: Node,
    modules: string[],
  ): Array<{ module: string; path: string[] }> {
    return this.importOriginsOfMany([value], modules).get(value) ?? [];
  }

  /**
   * The batched form: one demand set, one derivation, one round of
   * extraction shared by every value. A discovery pass asks about every
   * callee in a file, and per-value queries would re-pay demand
   * clearing and re-derivation once per call site.
   */
  importOriginsOfMany(
    values: readonly Node[],
    modules: string[],
  ): Map<Node, Array<{ module: string; path: string[] }>> {
    const results = new Map<Node, Array<{ module: string; path: string[] }>>();
    const pending: Array<{ value: Node; target: Node; key: string }> = [];
    for (const value of values) {
      const target = factKeyOf(value);
      const key = `origins|${nodeId(this.sharedDeclarationFor(target))}|${modules.join(",")}`;
      const cached = this.importOrigins.get(key);
      // An empty result was true of a smaller fact set; recompute it
      // once the store has extracted more files than it had then.
      if (
        cached !== undefined &&
        (cached.origins.length > 0 ||
          cached.extractedAt === this.fullyExtracted.size)
      ) {
        // A memo hit walks nothing, but whoever is collecting file
        // dependencies still read those files through it.
        for (const walkedPath of cached.walked) {
          recordFileDependency(walkedPath);
        }
        results.set(value, cached.origins);
        continue;
      }
      pending.push({ value, target, key });
    }
    if (pending.length === 0) {
      return results;
    }

    try {
      for (const one of pending) {
        this.wantValue("wantedCallOrigin", one.target);
        this.seedValue(one.target);
      }
      this.extractDemanded(pending.map((one) => one.target.getSourceFile()));

      for (const one of pending) {
        const origins = this.lookupImportOrigins(one.target, modules);
        results.set(one.value, origins);
        this.importOrigins.set(one.key, {
          origins,
          walked: [...this.lastQueryWalked],
          extractedAt: this.fullyExtracted.size,
        });
      }
      return results;
    } finally {
      this.forgetQuery();
    }
  }

  /**
   * The node a memo shares across references: a plain name's
   * declaration, so a hundred call sites of one import pay one walk.
   * Anything else keys as itself, since `a.foo` and `b.foo` share a
   * declared `foo` without sharing a value.
   */
  private sharedDeclarationFor(target: Node): Node {
    if (!Node.isIdentifier(target)) {
      return target;
    }
    let refersTo = this.declarations.get(target);
    if (refersTo === undefined) {
      refersTo = declarationOf(target);
      this.declarations.set(target, refersTo);
    }
    return refersTo;
  }

  private lookupImportOrigins(
    value: Node,
    modules: string[],
  ): Array<{ module: string; path: string[] }> {
    this.derive();

    // Its own demand class, without `callsInto`: a local helper that
    // calls into the package is not itself the package's export, and
    // that recursion is the expensive half of the rule set.
    const all: Array<{ module: string; path: string[] }> = [];
    for (const pair of this.answerPairsFor(
      "wantedCallOriginPair",
      nodeId(value),
    )) {
      const { module, name } = pairHalves(pair);
      all.push({ module, path: [name] });
    }
    for (const tuple of this.db.lookup(
      "wantedCallOriginMember",
      0,
      nodeId(value),
    )) {
      all.push({
        module: String(tuple[1]),
        path: [String(tuple[2]), String(tuple[3])],
      });
    }

    const matching = all.filter((one) => namesPackage(one.module, modules));
    // One import is recorded under several module keys, so origins
    // collapse per export path, and the specifier spelling wins for its
    // subpath.
    const byPath = new Map<string, { module: string; path: string[] }>();
    for (const one of matching) {
      const key = tupleKey(one.path);
      const kept = byPath.get(key);
      if (kept === undefined || spellsMoreOf(one.module, kept.module)) {
        byPath.set(key, one);
      }
    }
    // A member origin is the same derivation as its export pair, one
    // segment further, so the coarser reading gives way to it.
    const refined = new Set(
      [...byPath.values()]
        .filter((one) => one.path.length > 1)
        .map((one) => tupleKey(one.path.slice(0, -1))),
    );
    return [...byPath.values()]
      .filter((one) => !refined.has(tupleKey(one.path)))
      .sort((a, b) => a.path.join(".").localeCompare(b.path.join(".")));
  }

  private lookupImportedNames(value: Node, modules: string[]): string[] {
    this.derive();

    const reached = new Set(
      this.answerPairsFor("wantedComesFrom", nodeId(value)),
    );
    for (const target of this.answersFor("wantedComesTo", nodeId(value))) {
      for (const entry of this.answerPairsFor("wantedCallsInto", target)) {
        reached.add(entry);
      }
    }
    return namesFrom([...reached], modules);
  }

  private askAbout<T>(
    value: Node,
    question: Question,
    read: () => T,
    alsoFrom?: SourceFile,
  ): T {
    try {
      this.wantValue(question, value);
      this.seedValue(value);
      this.extractDemanded(
        alsoFrom === undefined
          ? [value.getSourceFile()]
          : [value.getSourceFile(), alsoFrom],
      );
      return read();
    } finally {
      this.forgetQuery();
    }
  }

  /**
   * Extract the seed files, then every module the rules ask for, until
   * they ask for nothing new. The files a question reads are then fixed
   * by the question alone, so its answer does not depend on what an
   * earlier question left in the store.
   */
  private extractDemanded(seeds: readonly SourceFile[]): void {
    const project = seeds[0]?.getProject();
    if (project === undefined) {
      return;
    }
    // Per query rather than per store: a file an earlier query read
    // still has its demand followed, or this query stops short.
    const read = new Set<string>();
    const considered = new Set<string>();
    this.lastQueryWalked = [];
    let pending: SourceFile[] = [...seeds];
    while (pending.length > 0) {
      const readThisRound: SourceFile[] = [];
      for (const sourceFile of pending) {
        const filePath = sourceFile.getFilePath();
        if (read.has(filePath)) {
          continue;
        }
        read.add(filePath);
        readThisRound.push(sourceFile);
        this.lastQueryWalked.push(filePath);
        // Even an empty answer read these files: their content decided
        // there was nothing to find, so a change to any of them can
        // change the answer.
        recordFileDependency(filePath);
        this.extractFile(sourceFile);
      }
      this.derive();

      pending = [];
      for (const moduleKey of this.demandedModules(readThisRound)) {
        if (considered.has(moduleKey)) {
          continue;
        }
        considered.add(moduleKey);
        const sourceFile = sourceFileFor(project, moduleKey);
        if (sourceFile !== undefined && !read.has(sourceFile.getFilePath())) {
          pending.push(sourceFile);
        }
      }
    }
  }

  /**
   * Module keys the rules are waiting on. Demand facts are cleared
   * between queries, so the demand relations contain this query's
   * alone; the unrestricted program has none, and follows the imports
   * of the files read this round instead.
   */
  private demandedModules(readThisRound: readonly SourceFile[]): string[] {
    if (RESOLUTION_PROGRAM.demands.length === 0) {
      return readThisRound.flatMap(importedModuleKeys);
    }
    return MODULE_DEMANDS.flatMap((relation) =>
      this.db.facts(relation).map((tuple) => String(tuple[0])),
    );
  }

  /**
   * The question and the chain that settled it are dropped. The files
   * the query extracted stay, since the next query reads the same facts.
   * Nothing is left half-done, so the store is not stale afterwards.
   */
  private forgetQuery(): void {
    if (QUERY_FACTS.length === 0) {
      return;
    }
    clearRelations(this.db, RESOLUTION_PROGRAM.rules, QUERY_FACTS);
    this.stale = false;
  }

  private wantValue(question: Question, value: Node): void {
    this.wantKey(question, nodeId(value));
  }

  /** For a question seeded with a fact key the store read out of the database. */
  private wantKey(question: Question, key: string): void {
    if (this.db.add(question, [key]) === "added") {
      this.stale = true;
    }
  }

  private wantExportsOf(filePath: string): void {
    if (this.db.add("wantedExportsOf", [filePath]) === "added") {
      this.stale = true;
    }
  }

  /**
   * Discovery walks the table in order, and the rounds derive it in
   * the order files arrived. Deriving it again from the demand alone,
   * over the loaded closure, orders it by the file's own statements.
   */
  private rederiveExportsOf(filePath: string): void {
    if (QUERY_FACTS.length === 0) {
      return;
    }
    this.db.retract("wantedModuleExport", [
      ...this.db.lookup("wantedModuleExport", 0, filePath),
    ]);
    this.forgetQuery();
    this.wantExportsOf(filePath);
    this.derive();
  }

  /**
   * File extraction only reaches values hanging off exports, and a query
   * can be rooted anywhere, so the queried value gets its own facts.
   */
  private seedValue(value: Node): void {
    if (!Node.isExpression(value)) {
      return;
    }
    const id = nodeId(value);
    if (this.seededValues.has(id)) {
      return;
    }
    this.seededValues.add(id);
    this.stale = true;
    emitValue(this.db, this.table, value);
  }

  private lookupObject(value: Node): Node | null {
    this.derive();

    const candidates = new Set<Node>();
    for (const target of this.answersFor("wantedComesTo", nodeId(value))) {
      const node = this.table.byId.get(target);
      if (node === undefined || isFunctionRoot(node)) {
        continue;
      }
      candidates.add(node);
    }

    if (candidates.size !== 1) {
      return null;
    }
    return [...candidates][0] as Node;
  }

  /**
   * A factory returning a wrapper's call gives back the wrapper's own
   * closure and the function it unwraps. The unwrapped one wins.
   */
  private lookupReturned(call: Node): Node | null {
    this.derive();
    return (
      this.singleFunctionIn("wantedGivesBackUnwrapped", call) ??
      this.singleFunctionIn("wantedGivesBack", call)
    );
  }

  private singleFunctionIn(relation: string, value: Node): Node | null {
    const candidates = new Set<Node>();
    for (const target of this.answersFor(relation, nodeId(value))) {
      const node = this.table.byId.get(target);
      if (node === undefined || !isFunctionRoot(node)) {
        continue;
      }
      candidates.add(node);
    }

    if (candidates.size !== 1) {
      return null;
    }
    return [...candidates][0] as Node;
  }

  /**
   * Two candidates give null, since ambiguity is nothing. The value
   * itself is never a result either, or an identifier whose chain went
   * nowhere would come back as itself.
   *
   * An answer has to be an expression, which leaves out the class a
   * construction makes an instance of. The README says why.
   */
  private lookupWritten(value: Node): Node | null {
    this.derive();

    const candidates = new Set<Node>();
    for (const target of this.answersFor("wantedIsWrittenAs", nodeId(value))) {
      const node = this.table.byId.get(target);
      if (node === undefined || node === value || !Node.isExpression(node)) {
        continue;
      }
      candidates.add(node);
    }

    if (candidates.size === 1) {
      return [...candidates][0] as Node;
    }
    const fallback = fallbackWrittenAs(this.db, nodeId(value), (keys) => {
      for (const key of keys) {
        this.wantKey("wanted", key);
      }
      this.derive();
    });
    return fallback === null ? null : (this.table.byId.get(fallback) ?? null);
  }

  /**
   * Read these files' facts now, before anything asks a question.
   *
   * A query follows the imports of the file it starts in, which is
   * where a value's definition is. What a caller passed is the other
   * direction, so a question about a parameter is answered only by
   * files the query never reaches on its own.
   */
  extractFiles(sourceFiles: Iterable<SourceFile>): void {
    for (const sourceFile of sourceFiles) {
      this.extractFile(sourceFile);
    }
  }

  /**
   * Which of these files reach any of these packages, following
   * project-local re-export chains. A barrel package that re-exports an
   * SDK defeats a per-file import check and does not defeat this.
   */
  filesImportingTransitively(
    fileSets: ReadonlyArray<FileSetQuery>,
  ): ReadonlyArray<ReadonlySet<SourceFile>> {
    return this.graph.filesReachingAnyPackage(fileSets);
  }

  /**
   * The calls behind a receiver that `matches` accepts. The caller
   * applies the single-answer policy to the set; the resolution
   * README's anchor section says why the rules cannot rank a nearer
   * call above a farther one.
   */
  anchorCallsOf(value: Node, matches: (call: Node) => boolean): Node[] {
    const target = factKeyOf(value);
    return this.askAbout(target, "wantedAnchor", () => {
      this.derive();
      const found: Node[] = [];
      for (const id of this.answersFor("wantedAnchorCall", nodeId(target))) {
        const node = this.table.byId.get(id);
        if (node !== undefined && matches(node)) {
          found.push(node);
        }
      }
      return found;
    });
  }

  /**
   * Every name a module exports and the values behind each, with
   * re-export chains flattened by the rules. The demand follows
   * re-export targets only, so a barrel of barrels extracts its own
   * chain and nothing beside it, to any depth.
   */
  exportsOf(sourceFile: SourceFile): Map<string, Node[]> {
    const filePath = sourceFile.getFilePath();
    const memo = this.exportTables.get(filePath);
    if (memo !== undefined) {
      recordFileDependency(filePath);
      return memo;
    }

    try {
      const table = this.collectExports(sourceFile);
      this.exportTables.set(filePath, table);
      return table;
    } finally {
      this.forgetQuery();
    }
  }

  private collectExports(sourceFile: SourceFile): Map<string, Node[]> {
    const filePath = sourceFile.getFilePath();
    this.wantExportsOf(filePath);
    this.extractDemanded([sourceFile]);
    this.rederiveExportsOf(filePath);

    const exports = new Map<string, Node[]>();
    for (const tuple of this.db.lookup("wantedModuleExport", 0, filePath)) {
      const node = this.table.byId.get(String(tuple[2]));
      if (node === undefined) {
        continue;
      }
      const name = String(tuple[1]);
      const bucket = exports.get(name);
      if (bucket === undefined) {
        exports.set(name, [node]);
      } else if (!bucket.includes(node)) {
        bucket.push(node);
      }
    }
    return exports;
  }

  /**
   * The single-answer policy stays with the callers: a value with two
   * sources is something to say at the site, not something to pick from.
   */
  private lookupSources(value: Node): Node[] {
    this.derive();

    const candidates = new Set<Node>();
    for (const target of this.answersFor("wantedResolves", nodeId(value))) {
      const resolved = this.table.byId.get(target);
      if (resolved === undefined) {
        continue;
      }
      if (resolved !== value || isFunctionRoot(value)) {
        candidates.add(resolved);
      }
    }

    return [...candidates];
  }

  private derive(): void {
    if (!this.stale) {
      return;
    }
    this.stale = false;
    evaluate(this.db, RESOLUTION_PROGRAM.rules);
  }

  private answersFor(relation: string, value: string): string[] {
    return withoutOverridden(
      this.db,
      value,
      this.db.lookup(relation, 0, value).map((tuple) => String(tuple[1])),
    );
  }

  /**
   * The trailing pair of a three-column relation, joined so a Set dedupes
   * on both halves. The join uses the database's own tuple encoding,
   * since a specifier or an identifier can contain any separator
   * character.
   */
  private answerPairsFor(relation: string, value: string): string[] {
    return this.db
      .lookup(relation, 0, value)
      .map((tuple) => tupleKey([String(tuple[1]), String(tuple[2])]));
  }

  private extractFile(sourceFile: SourceFile): void {
    const filePath = sourceFile.getFilePath();
    if (this.fullyExtracted.has(filePath)) {
      return;
    }
    this.fullyExtracted.add(filePath);
    this.stale = true;
    extractFileFacts(this.db, this.table, sourceFile);
  }
}

function namesFrom(pairs: string[], packages: string[]): string[] {
  const names = new Set<string>();
  for (const pair of pairs) {
    const { module, name } = pairHalves(pair);
    if (namesPackage(module, packages)) {
      names.add(name);
    }
  }
  return [...names].sort();
}

function pairHalves(pair: string): { module: string; name: string } {
  const [module = "", name = ""] = tupleKeyParts(pair);
  return { module, name };
}

/**
 * Whether `module` says more about an import than `kept` does: a
 * specifier over a resolved path, and `pkg/esm` over `pkg`.
 */
function spellsMoreOf(module: string, kept: string): boolean {
  return (
    kept.startsWith("/") ||
    (!module.startsWith("/") && module.startsWith(`${kept}/`))
  );
}

/**
 * The key is a resolved file path when the package is installed and the
 * raw specifier when it is not, so both forms have to be looked up.
 */
function namesPackage(moduleKey: string, packages: string[]): boolean {
  return namesAnyPackage(
    [moduleKey, ...packagesDeclaring(moduleKey)],
    packages,
  );
}

/** A value that refers to nothing speaks for itself. */
function declarationOf(value: Node): Node {
  const nameNode = Node.isPropertyAccessExpression(value)
    ? value.getNameNode()
    : value;
  return nameNode.getSymbol()?.getDeclarations()[0] ?? value;
}
