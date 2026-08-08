// store.ts - the resolution store and the questions it answers.
//
// resolveCallable: which function does this value resolve to, through
// any depth of aliasing, imports, re-export barrels, wrapper
// factories, and .bind.
//
// resolveWrittenValue: which expression is this value written as, for
// callers after something that is neither a function nor an object.
//
// filesImportingTransitively: for each set of files and packages, which
// of those files reach any of those packages through their imports,
// following project-local re-export chains. The per-file import check
// is defeated by a barrel package that re-exports an SDK; this one is
// not.
//
// Facts are extracted per file on demand and only along the module
// edges a query follows, so cost tracks the indirection present, not
// project size.

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
  // f.bind(...) comes to whatever f comes to.
  rule(
    "comesTo",
    [v("r"), v("h")],
    [lit("bindCall", v("r"), v("t")), lit("comesTo", v("t"), v("h"))],
  ),
];

/**
 * What this adapter evaluates: the shared language rules, the ones that
 * are about JavaScript in particular, and the questions a caller asks,
 * rewritten so a chain is followed only where a question reaches it.
 *
 * On a codebase dense enough for these rules to matter the rewrite is
 * most of the run, so the escape hatch stays: `SUSS_RESOLUTION_ON_DEMAND=0`
 * runs the same rules unrestricted. Both settings answer every question
 * the same way, and the difference is how much never gets derived.
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
 * The two ways a caller can ask about a value: what it is, or where the
 * name came from. Each one is a fact the rules read.
 */
type Question = "wanted" | "wantedOrigin";

/**
 * What one query brings into the database, and what goes again once its
 * answer has been read: the asking fact, the chain the rules followed
 * from it, and the demand that made them follow it.
 *
 * Without this a query pays for every question asked before it. Asking
 * marks the store stale, so the next file's facts are derived over all
 * the demand accumulated so far, and a pack that asks about every
 * export turns a run into the square of what it asks. The answer
 * relations are not in here: they hold one row per value asked about,
 * which is what a repeated query reads back instead of asking again.
 */
const QUERY_FACTS: readonly string[] =
  RESOLUTION_PROGRAM.demandDriven.length === 0
    ? []
    : [...RESOLUTION_PROGRAM.demandDriven, "wanted", "wantedOrigin"];

/**
 * How many module hops a query follows when pulling in facts. Deep
 * enough for barrels of barrels; a bound so a pathological import
 * graph stays cheap.
 */
const MAX_MODULE_HOPS = 6;

export class ResolutionStore {
  private readonly db = new Database();
  private readonly table: NodeTable = createNodeTable();
  private readonly fullyExtracted = new Set<string>();
  private readonly seededValues = new Set<string>();
  private readonly importedNames = new Map<string, string[]>();
  private readonly graph = new ModuleGraph();

  private stale = true;

  constructor(wrappers: TransparentWrapper[] = []) {
    for (const wrapper of wrappers) {
      this.db.add("unwrapsByName", [wrapper.callee, String(wrapper.argument)]);
      this.db.add("wrapperModule", [wrapper.callee, wrapper.module]);
    }
  }

  /**
   * The function `value` resolves to, or null when no chain reaches
   * one. The result is a ts-morph node in whatever file the function
   * actually lives.
   *
   * Facts come in waves: extract the file the value lives in, ask, and
   * only widen to the files it imports when the answer is still
   * missing. A value that resolves without leaving its own file costs
   * one file of extraction, not the whole import closure.
   */
  resolveCallable(value: Node): Node | null {
    const target = factKeyOf(value);
    return this.resolveByWaves(target, "wanted", () => this.lookup(target));
  }

  /**
   * The object literal `value` ends up being, or null. The route a
   * registration call names often lives on a shared object built in
   * another file, and this is how discovery reads it back.
   */
  resolveObject(value: Node): Node | null {
    const target = factKeyOf(value);
    return this.resolveByWaves(target, "wanted", () =>
      this.lookupObject(target),
    );
  }

  /**
   * The expression `value` is written as, or null. Unlike the other two
   * questions this one does not care what kind of expression it lands
   * on, so it answers for values that are neither functions nor
   * objects: a GraphQL document held in a named constant in another
   * file comes back as the template literal or tag call that built it.
   *
   * A value the code computes has no written form to report, so the
   * answer is the computing expression itself and the caller gets
   * nothing it can use, which is the point.
   */
  resolveWrittenValue(value: Node): Node | null {
    const target = factKeyOf(value);
    return this.resolveByWaves(target, "wanted", () =>
      this.lookupWritten(target),
    );
  }

  /**
   * The names from `modules` this value stands for. A value stands for
   * a library name two ways, and a caller asking which library concept
   * something is wants both:
   *
   *   - it is that name, under whatever local spelling. `import
   *     { Controller as Resource }` makes `Resource` the library's
   *     `Controller`.
   *   - calling it calls that name. A project decorator written as
   *     `(path) => Controller(path)` marks a controller, and so does
   *     one written as `applyDecorators(Controller(path))`.
   *
   * Several names is the normal answer rather than an ambiguity, since
   * a wrapper composing two library decorators applies both. The caller
   * asks whether the name it cares about is among them.
   *
   * One wrapper is applied across hundreds of files, so the answer is
   * memoized against the declaration it was asked about. Without that,
   * every use site seeds a fresh value and pays another fixpoint.
   */
  importedNamesOf(value: Node, modules: string[]): string[] {
    const declaration = `${nodeId(declarationOf(value))}|${modules.join(",")}`;
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
   * The names from `modules` this value stands for, or null while the
   * walk should keep widening.
   *
   * The distinction is what keeps the cost down. A value that has
   * arrived at a package has nothing more to give, because a library's
   * own body is not here to read, so a decorator from a library the
   * caller did not ask about stops on the first wave rather than
   * running out the import closure looking for a match it will never
   * find. A value that has only arrived at another file in the project
   * keeps going, since the wrapper it names is declared somewhere the
   * walk has not reached yet.
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

    // Where the walk has been on this query, which is separate from
    // which files already have facts. A file extracted by an earlier
    // query still has to be walked through, or the frontier collapses
    // and later queries into the same file answer null.
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
   * The answer has been read, so the question and the chain that
   * answered it can go. What the query extracted stays: files are the
   * expensive part and the next query reads the same facts.
   *
   * Nothing is owed after this. The rules have seen every fact the
   * database holds and concluded what the demand still present asks
   * for, which is none, so the next query starts from its own asking
   * fact.
   */
  private forgetQuery(): void {
    if (QUERY_FACTS.length === 0) {
      return;
    }
    clearRelations(this.db, RESOLUTION_PROGRAM.rules, QUERY_FACTS);
    this.stale = false;
  }

  /**
   * Somebody asked about this value, which is what the rules follow
   * chains for. Separate from `seedValue`, which only speaks for values
   * that are expressions; a caller can ask about a declaration too, and
   * the answer is still owed.
   */
  private wantValue(question: Question, value: Node): void {
    if (this.db.add(question, [nodeId(value)])) {
      this.stale = true;
    }
  }

  /**
   * Facts for the queried value itself. File extraction only reaches
   * values that hang off exports, and a query can be rooted anywhere:
   * a registration call passes `routes.provision` as an argument, and
   * nothing else ever emits facts for that expression.
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
   * Reaching two different expressions means the rules cannot tell
   * which one the value is written as, and the same reasoning applies
   * as for the other two questions: ambiguity is nothing. The value
   * itself is not an answer, or every identifier would answer with
   * itself the moment its chain went nowhere.
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
   * For each set of files and packages, which of those files reach any
   * of those packages through their imports, following project-local
   * re-export chains.
   */
  filesImportingTransitively(
    fileSets: ReadonlyArray<FileSetQuery>,
  ): ReadonlyArray<ReadonlySet<SourceFile>> {
    return this.graph.filesReachingAnyPackage(fileSets);
  }

  /**
   * The one function this value resolves to. Several rules can reach
   * the same answer, which is fine, but reaching two different
   * functions means the rules cannot tell which one the value is, and
   * picking whichever landed in the relation first would make the
   * answer depend on the order facts arrived in. Ambiguity is nothing.
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

  /** Run the rules to fixpoint. */
  private derive(): void {
    if (!this.stale) {
      return;
    }
    this.stale = false;
    evaluate(this.db, RESOLUTION_PROGRAM.rules);
  }

  /**
   * The second column of an answer relation, for the value asked about.
   * The database indexes a column the first time somebody looks it up
   * and keeps that index as facts arrive, so this is a map hit and the
   * answers a query never asks about cost nothing.
   */
  private answersFor(relation: string, value: string): string[] {
    return this.db.lookup(relation, 0, value).map((tuple) => String(tuple[1]));
  }

  /**
   * The trailing pair of a three-column answer relation, joined into
   * one string so a Set can dedupe on both halves at once.
   *
   * The join is the database's own tuple encoding, where every half
   * carries its own length. A module specifier or an identifier can
   * hold any character, so a separator picked here would sooner or
   * later be one of them and two different pairs would answer to the
   * same string.
   */
  private answerPairsFor(relation: string, value: string): string[] {
    return this.db
      .lookup(relation, 0, value)
      .map((tuple) => tupleKey([String(tuple[1]), String(tuple[2])]));
  }

  /** Emit a file's facts, unless some earlier query already did. */
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

/** The names among these module-and-name pairs that come from `packages`. */
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

/** The two halves of a joined module-and-name pair, back apart. */
function pairHalves(pair: string): { module: string; name: string } {
  const [module = "", name = ""] = tupleKeyParts(pair);
  return { module, name };
}

/**
 * Whether a module key names a package rather than a file in the
 * project. A specifier that did not resolve stays as written, and one
 * that resolved into a dependency is an absolute path through
 * node_modules.
 */
function namesAPackage(moduleKey: string): boolean {
  return !moduleKey.startsWith("/") || moduleKey.includes("/node_modules/");
}

/**
 * Whether an `imports` module key names one of these packages. The key
 * is a resolved file path when the package is installed and the raw
 * specifier when it is not, so both readings have to answer.
 */
function namesPackage(moduleKey: string, packages: string[]): boolean {
  return namesAnyPackage(
    [moduleKey, ...packagesDeclaring(moduleKey)],
    packages,
  );
}

/**
 * The declaration a value refers to, so one wrapper applied across a
 * hundred files is asked about once. A value that refers to nothing
 * speaks for itself.
 */
function declarationOf(value: Node): Node {
  const nameNode = Node.isPropertyAccessExpression(value)
    ? value.getNameNode()
    : value;
  return nameNode.getSymbol()?.getDeclarations()[0] ?? value;
}
