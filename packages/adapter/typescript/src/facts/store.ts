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
  rule,
  tupleKey,
  tupleKeyParts,
  variable as v,
} from "@suss/datalog";
import {
  ANSWER_RELATIONS,
  RESOLUTION_QUESTIONS,
  RESOLUTION_RULES as SHARED_RULES,
} from "@suss/resolution";

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

import type { TransparentWrapper } from "@suss/extractor";
import type { SourceFile } from "ts-morph";

const JS_RULES = [
  // f.bind(...) resolves to whatever f resolves to.
  rule(
    "comesTo",
    [v("r"), v("h")],
    [lit("bindCall", v("r"), v("t")), lit("comesTo", v("t"), v("h"))],
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

export class ResolutionStore {
  private readonly db = new Database();
  private readonly table: NodeTable = createNodeTable();
  private readonly fullyExtracted = new Set<string>();
  private readonly seededValues = new Set<string>();
  private readonly importedNames = new Map<string, string[]>();
  private readonly declarations = new Map<Node, Node>();
  private readonly graph = new ModuleGraph();

  private stale = true;

  constructor(wrappers: TransparentWrapper[] = []) {
    for (const wrapper of wrappers) {
      this.db.add("unwrapsByName", [wrapper.callee, String(wrapper.argument)]);
      this.db.add("wrapperModule", [wrapper.callee, wrapper.module]);
    }
  }

  resolveCallable(value: Node): Node | null {
    const target = factKeyOf(value);
    return this.resolveByWaves(target, "wanted", () => this.lookup(target));
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
      return cached;
    }
    const target = factKeyOf(value);
    const found =
      this.resolveByWaves(target, "wantedOrigin", () =>
        this.lookupImportedNames(target, modules),
      ) ?? [];
    this.importedNames.set(declaration, found);
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
  ): T | null {
    try {
      return this.walkForAnswer(value, question, ask);
    } finally {
      this.forgetQuery();
    }
  }

  private walkForAnswer<T>(
    value: Node,
    question: Question,
    ask: () => T | null,
  ): T | null {
    this.wantValue(question, value);
    this.seedValue(value);

    // Per query rather than per store. A file an earlier query extracted
    // still has to be walked through, or the frontier collapses and this
    // query comes back null.
    const walked = new Set<string>();
    let frontier = [value.getSourceFile()];

    for (let hop = 0; hop <= MAX_MODULE_HOPS; hop++) {
      const next: SourceFile[] = [];
      for (const sourceFile of frontier) {
        if (walked.has(sourceFile.getFilePath())) {
          continue;
        }
        walked.add(sourceFile.getFilePath());
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
    if (this.db.add(question, [nodeId(value)])) {
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
