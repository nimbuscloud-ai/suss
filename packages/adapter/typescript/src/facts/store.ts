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
import type { SourceFile } from "ts-morph";

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
]);

type Question = "wanted" | "wantedOrigin";

/**
 * Dropped once a query's result has been read, so the next query does
 * not re-derive over every question asked before it. The answer
 * relations stay, and a repeated query reads its result from those.
 */
const QUERY_FACTS: readonly string[] =
  RESOLUTION_PROGRAM.demandDriven.length === 0
    ? []
    : [...RESOLUTION_PROGRAM.demandDriven, "wanted", "wantedOrigin"];

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
    const target = factKeyOf(value);
    return this.resolveByWaves(
      target,
      "wanted",
      () => this.lookup(target),
      alsoFrom,
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
    return this.resolveByWaves(target, "wanted", () =>
      this.lookupWritten(target),
    );
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
   */
  private lookupWritten(value: Node): Node | null {
    this.derive();

    const candidates = new Set<Node>();
    for (const target of this.answersFor("wantedIsWrittenAs", nodeId(value))) {
      const node = this.table.byId.get(target);
      if (node === undefined || node === value) {
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
   * Two candidates give null. Picking whichever arrived first would make
   * the result depend on the order the facts came in.
   */
  private lookup(value: Node): Node | null {
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

    if (candidates.size !== 1) {
      return null;
    }
    return [...candidates][0] as Node;
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
