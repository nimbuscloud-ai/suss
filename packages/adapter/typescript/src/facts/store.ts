/**
 * The resolution store, and the three questions callers ask it.
 *
 * `resolveCallable` says which function a value comes down to, through
 * any depth of aliasing, imports, re-export barrels, wrapper factories
 * and `.bind`. `resolveWrittenValue` says which expression a value is
 * written as, for callers chasing something that is neither a function
 * nor an object. `filesImportingTransitively` says which of a set of
 * files reach any of a set of packages, which a per-file import check
 * misses whenever a local barrel re-exports the SDK.
 *
 * Facts are extracted per file on demand and only along the module
 * edges a query follows, so cost tracks how indirect the code is.
 */

import { Node } from "ts-morph";

import {
  clearRelations,
  Database,
  deriveOnDemand,
  evaluate,
  lit,
  type OnDemandRules,
  proofOf,
  rule,
  tupleKey,
  tupleKeyParts,
  variable as v,
  witnesses,
} from "@suss/datalog";
import {
  ANSWER_RELATIONS,
  RESOLUTION_QUESTIONS,
  RESOLUTION_RULES as SHARED_RULES,
  VALUE_STEP,
} from "@suss/resolution";

import { recordFileDependency } from "../depTracking.js";
import { isFunctionRoot } from "../discovery/shared.js";
import {
  createNodeTable,
  emitValue,
  extractFileFacts,
  factKeyOf,
  type NodeTable,
  nodeId,
  packagesDeclaring,
} from "./extract.js";
import {
  type FileSetQuery,
  ModuleGraph,
  namesAnyPackage,
} from "./moduleGraph.js";

import type { Atom, Proof } from "@suss/datalog";
import type { TransparentWrapper } from "@suss/extractor";
import type { Project, SourceFile } from "ts-morph";

const JS_RULES = [
  // f.bind(...) leads wherever f leads. Stated as a step, so the
  // questions other than `comesTo` follow it too.
  rule(
    "stepsTo",
    [v("r"), v("t"), VALUE_STEP],
    [lit("bindCall", v("r"), v("t"))],
    "bind",
  ),
];

/**
 * `SUSS_RESOLUTION_ON_DEMAND=0` runs the same rules unrestricted. Both
 * settings give the same result for every question; they differ only in
 * how much never gets derived at all.
 */
const RESOLUTION_PROGRAM: OnDemandRules =
  process.env.SUSS_RESOLUTION_ON_DEMAND === "0"
    ? {
        rules: [...SHARED_RULES, ...JS_RULES, ...RESOLUTION_QUESTIONS],
        demandDriven: [],
      }
    : deriveOnDemand(
        [...SHARED_RULES, ...JS_RULES, ...RESOLUTION_QUESTIONS],
        ANSWER_RELATIONS,
      );

/**
 * What a why-question re-evaluates: the rules as written, with no
 * demand transform. Witnesses must record the original rules, and
 * `deriveOnDemand` refuses algebras, so the proof pass is exhaustive
 * over the base facts the demand walk extracted.
 */
const WITNESS_RULES = [...SHARED_RULES, ...JS_RULES];

/** Every relation some variant of the program derives, or asks with. */
const NOT_BASE_FACTS = new Set([
  ...[...SHARED_RULES, ...JS_RULES, ...RESOLUTION_QUESTIONS].map(
    (r) => r.head.relation,
  ),
  ...RESOLUTION_PROGRAM.rules.map((r) => r.head.relation),
  "wanted",
  "wantedOrigin",
  "wantedCallOrigin",
  "wantedExportsOf",
  "wantedAnchor",
]);

type Question = "wanted" | "wantedOrigin" | "wantedCallOrigin" | "wantedAnchor";

/**
 * Dropped once a query's result has been read, so the next query does
 * not re-derive over every question asked before it. The answer
 * relations stay, and a repeated query reads its result from those.
 */
const QUERY_FACTS: readonly string[] =
  RESOLUTION_PROGRAM.demandDriven.length === 0
    ? []
    : [
        ...RESOLUTION_PROGRAM.demandDriven,
        "wanted",
        "wantedOrigin",
        "wantedCallOrigin",
        "wantedExportsOf",
        "wantedAnchor",
      ];

/** Deep enough for barrels of barrels, bounded so a wide graph stays cheap. */
const MAX_MODULE_HOPS = 6;

export interface ExplainCallableOptions {
  /** A second file to walk out from; see `resolveCallable`. */
  alsoFrom?: SourceFile;
  /** How many derived nodes deep the proof walk goes; see `proofOf`. */
  maxDepth?: number;
}

/** What one witness re-evaluation cost, said rather than hidden. */
export interface ExplainStats {
  /** Facts the demand walk had extracted, which the proof pass reran. */
  baseFacts: number;
  /** Facts the exhaustive pass derived on top of those. */
  derivedFacts: number;
  evaluateMs: number;
}

export interface ExplainedResolution {
  /** The node the value comes down to. */
  target: Node;
  proof: Proof;
  /** The source node behind a proof atom, when the atom is a node id. */
  nodeFor: (atom: Atom) => Node | undefined;
  stats: ExplainStats;
}

export class ResolutionStore {
  private readonly db = new Database();
  private readonly table: NodeTable = createNodeTable();
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
  /**
   * A file's table depends only on its re-export closure, which
   * `collectExports` extracts whole before answering, so later
   * extraction elsewhere cannot change an entry.
   */
  private readonly exportTables = new Map<string, Map<string, Node[]>>();
  /** Files the most recent wave walk entered, for the memo to keep. */
  private lastQueryWalked: string[] = [];
  private readonly declarations = new Map<Node, Node>();
  private readonly graph = new ModuleGraph();

  private stale = true;

  constructor(wrappers: TransparentWrapper[] = []) {
    for (const wrapper of wrappers) {
      this.db.add("unwrapsByName", [wrapper.callee, String(wrapper.argument)]);
      this.db.add("wrapperModule", [wrapper.callee, wrapper.module]);
    }
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
    return (
      this.resolveByWaves(
        target,
        "wanted",
        () => this.lookupSources(target),
        alsoFrom,
      ) ?? []
    );
  }

  /**
   * The witness proof behind `resolveCallable`'s answer. Resolves the
   * value first, which walks files and extracts facts in the usual
   * waves, then re-evaluates the rules over those base facts under the
   * witness algebra and rebuilds the proof of the answer. Null when
   * the value does not resolve at all.
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
    return this.resolveByWaves(target, "wanted", () =>
      this.lookupObject(target),
    );
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

    const settled = this.resolveByWaves(target, "wanted", () =>
      this.lookupWritten(target),
    );
    this.writtenValues.set(key, {
      written: settled?.written ?? null,
      walked: [...this.lastQueryWalked],
      extractedAt: this.fullyExtracted.size,
    });
    return settled?.written ?? null;
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
    const found =
      this.resolveByWaves(target, "wantedOrigin", () =>
        this.lookupImportedNames(target, modules),
      ) ?? [];
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
   * The batched form: one demand set, one derivation, one widening
   * walk shared by every value. A discovery pass asks about every
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

      const walked = new Set<string>();
      this.lastQueryWalked = [];
      let frontier: SourceFile[] = [];
      for (const one of pending) {
        const file = one.target.getSourceFile();
        if (!walked.has(file.getFilePath()) && !frontier.includes(file)) {
          frontier.push(file);
        }
      }

      const open = new Set(pending);
      for (let hop = 0; hop <= MAX_MODULE_HOPS && open.size > 0; hop++) {
        const next: SourceFile[] = [];
        for (const sourceFile of frontier) {
          if (walked.has(sourceFile.getFilePath())) {
            continue;
          }
          walked.add(sourceFile.getFilePath());
          this.lastQueryWalked.push(sourceFile.getFilePath());
          // Even a null answer read these files: their content decided
          // there was nothing to find, so a change to any of them can
          // change the answer.
          recordFileDependency(sourceFile.getFilePath());
          this.extractFile(sourceFile);
          next.push(...this.graph.importedFilesOf(sourceFile));
        }

        for (const one of [...open]) {
          const found = this.lookupImportOrigins(one.target, modules);
          if (found !== null) {
            results.set(one.value, found);
            this.importOrigins.set(one.key, {
              origins: found,
              walked: [...this.lastQueryWalked],
              extractedAt: this.fullyExtracted.size,
            });
            open.delete(one);
          }
        }
        if (next.length === 0) {
          break;
        }
        frontier = next;
      }

      for (const one of open) {
        results.set(one.value, []);
        this.importOrigins.set(one.key, {
          origins: [],
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
  ): Array<{ module: string; path: string[] }> | null {
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
    // One import is recorded under two module keys, the resolved path
    // and the specifier, so origins collapse per export path, and the
    // specifier spelling wins for its subpath.
    const byPath = new Map<string, { module: string; path: string[] }>();
    for (const one of matching) {
      const key = tupleKey(one.path);
      const kept = byPath.get(key);
      if (kept === undefined || kept.module.startsWith("/")) {
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
    const origins = [...byPath.values()]
      .filter((one) => !refined.has(tupleKey(one.path)))
      .sort((a, b) => a.path.join(".").localeCompare(b.path.join(".")));
    if (origins.length > 0) {
      return origins;
    }
    return all.some((one) => namesAPackage(one.module)) ? [] : null;
  }

  /**
   * Null tells the walk to keep widening. A value that landed in a
   * package returns empty instead, because a library's own body is not
   * here to read and widening would never find anything.
   */
  private lookupImportedNames(value: Node, modules: string[]): string[] | null {
    this.derive();

    const origins = this.answerPairsFor("wantedComesFrom", nodeId(value));
    const reached = new Set(origins);
    for (const target of this.answersFor("wantedComesTo", nodeId(value))) {
      for (const entry of this.answerPairsFor("wantedCallsInto", target)) {
        reached.add(entry);
      }
    }

    const names = namesFrom([...reached], modules);
    if (names.length > 0) {
      return names;
    }
    return origins.some((pair) => namesAPackage(pairHalves(pair).module))
      ? []
      : null;
  }

  private resolveByWaves<T>(
    value: Node,
    question: Question,
    ask: () => T | null,
    alsoFrom?: SourceFile,
  ): T | null {
    try {
      return this.walkForAnswer(value, question, ask, alsoFrom);
    } finally {
      this.forgetQuery();
    }
  }

  private walkForAnswer<T>(
    value: Node,
    question: Question,
    ask: () => T | null,
    alsoFrom?: SourceFile,
  ): T | null {
    this.wantValue(question, value);
    this.seedValue(value);

    // Per query rather than per store. A file an earlier query extracted
    // still has to be walked through, or the frontier collapses and this
    // query comes back null.
    const walked = new Set<string>();
    this.lastQueryWalked = [];
    let frontier =
      alsoFrom === undefined
        ? [value.getSourceFile()]
        : [value.getSourceFile(), alsoFrom];

    for (let hop = 0; hop <= MAX_MODULE_HOPS; hop++) {
      const next: SourceFile[] = [];
      for (const sourceFile of frontier) {
        if (walked.has(sourceFile.getFilePath())) {
          continue;
        }
        walked.add(sourceFile.getFilePath());
        this.lastQueryWalked.push(sourceFile.getFilePath());
        // Even a null answer read these files: their content decided
        // there was nothing to find, so a change to any of them can
        // change the answer.
        recordFileDependency(sourceFile.getFilePath());
        this.extractFile(sourceFile);
        next.push(...this.graph.importedFilesOf(sourceFile));
      }
      const found = ask();
      if (found !== null) {
        return found;
      }
      if (next.length === 0) {
        return null;
      }
      frontier = next;
    }
    return null;
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
    if (this.db.add(question, [nodeId(value)]) === "added") {
      this.stale = true;
    }
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
   * Two candidates give null, since ambiguity is nothing. The value
   * itself is never a result either, or an identifier whose chain went
   * nowhere would come back as itself.
   *
   * An answer has to be an expression, which leaves out the class a
   * construction makes an instance of. The README says why.
   */
  private lookupWritten(value: Node): { written: Node | null } | null {
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
      return { written: [...candidates][0] as Node };
    }
    // Two candidates is settled refusal, since more files can only add
    // candidates, never take one away.
    if (candidates.size > 1) {
      return { written: null };
    }
    if (neverWritable(value)) {
      return { written: null };
    }
    return null;
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
   * The calls behind a receiver that `matches` accepts, walked out in
   * waves the way every question is. The wave ends as soon as one file
   * yields a match, and the caller applies the single-answer policy to
   * the set; the resolution README's anchor section says why the rules
   * cannot rank a nearer call above a farther one.
   */
  anchorCallsOf(value: Node, matches: (call: Node) => boolean): Node[] {
    const target = factKeyOf(value);
    return (
      this.resolveByWaves(target, "wantedAnchor", () => {
        this.derive();
        const found: Node[] = [];
        for (const id of this.answersFor("wantedAnchorCall", nodeId(target))) {
          const node = this.table.byId.get(id);
          if (node !== undefined && matches(node)) {
            found.push(node);
          }
        }
        return found.length === 0 ? null : found;
      }) ?? []
    );
  }

  /**
   * Every name a module exports and the values behind each, with
   * re-export chains flattened by the rules. The frontier follows
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
    const project = sourceFile.getProject();
    const walked = new Set<string>();
    let frontier = [sourceFile];
    while (frontier.length > 0) {
      const next: SourceFile[] = [];
      for (const file of frontier) {
        const filePath = file.getFilePath();
        if (walked.has(filePath)) {
          continue;
        }
        walked.add(filePath);
        recordFileDependency(filePath);
        this.extractFile(file);
        for (const target of this.reExportTargetsOf(filePath)) {
          const targetFile = sourceFileFor(project, target);
          if (targetFile !== undefined) {
            next.push(targetFile);
          }
        }
      }
      frontier = next;
    }

    const filePath = sourceFile.getFilePath();
    if (this.db.add("wantedExportsOf", [filePath]) === "added") {
      this.stale = true;
    }
    this.derive();

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

  /** Module keys this file re-exports from, read off its own facts. */
  private reExportTargetsOf(filePath: string): string[] {
    const targets = new Set<string>();
    for (const tuple of this.db.lookup("reExports", 0, filePath)) {
      targets.add(String(tuple[2]));
    }

    for (const tuple of this.db.lookup("reExportsAll", 0, filePath)) {
      targets.add(String(tuple[1]));
    }

    return [...targets];
  }

  /**
   * Null keeps the wave walk widening; any candidate at all ends it,
   * since more files can only add candidates, never take one away. The
   * single-answer policy stays with the callers: picking one of two
   * would make the result depend on the order the facts came in.
   */
  private lookupSources(value: Node): Node[] | null {
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

    return candidates.size === 0 ? null : [...candidates];
  }

  private derive(): void {
    if (!this.stale) {
      return;
    }
    this.stale = false;
    evaluate(this.db, RESOLUTION_PROGRAM.rules);
  }

  private answersFor(relation: string, value: string): string[] {
    return this.db.lookup(relation, 0, value).map((tuple) => String(tuple[1]));
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

/**
 * A re-export target the project has not loaded yet, such as a
 * dependency's .d.ts, is added by its resolved path. A key that is a
 * bare specifier never resolved to a file, so there is nothing to add.
 */
function sourceFileFor(
  project: Project,
  moduleKey: string,
): SourceFile | undefined {
  const known = project.getSourceFile(moduleKey);
  if (known !== undefined) {
    return known;
  }

  if (!moduleKey.startsWith("/")) {
    return undefined;
  }

  try {
    return project.addSourceFileAtPathIfExists(moduleKey) ?? undefined;
  } catch {
    return undefined;
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
 * A specifier that did not resolve stays as written, and one that
 * resolved into a dependency is an absolute path through node_modules.
 */
function namesAPackage(moduleKey: string): boolean {
  return !moduleKey.startsWith("/") || moduleKey.includes("/node_modules/");
}

/**
 * The key is a resolved file path when the package is installed and the
 * raw specifier when it is not, so both forms have to be looked up.
 */
/**
 * Whether no amount of extraction can produce a written value: the
 * name is declared inside a package, whose body is not here to read.
 * A parameter is not on this list, since the argument step gives it
 * the value a caller passes, and the caller can be in a wider file.
 */
function neverWritable(value: Node): boolean {
  if (!Node.isIdentifier(value)) {
    return false;
  }
  const declarations = value.getSymbol()?.getDeclarations() ?? [];
  return declarations.some((declaration) =>
    declaration.getSourceFile().getFilePath().includes("/node_modules/"),
  );
}

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
