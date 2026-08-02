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

import { Database, evaluate, lit, rule, variable as v } from "@suss/datalog";
import { RESOLUTION_RULES as SHARED_RULES } from "@suss/resolution";

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
 * What this adapter evaluates: the shared language rules, plus the ones
 * that are about JavaScript in particular.
 */
const RESOLUTION_RULES = [...SHARED_RULES, ...JS_RULES];

/**
 * How many module hops a query follows when pulling in facts. Deep
 * enough for barrels of barrels; a bound so a pathological import
 * graph stays cheap.
 */
const MAX_MODULE_HOPS = 6;

/**
 * Joins the two trailing columns of a three-column relation into one
 * index key. A NUL cannot appear in a module specifier or an
 * identifier, so the halves come back apart intact.
 */
const PAIR_SEPARATOR = "\0";

export class ResolutionStore {
  private readonly db = new Database();
  private readonly table: NodeTable = createNodeTable();
  private readonly fullyExtracted = new Set<string>();
  private readonly seededValues = new Set<string>();
  private readonly importedNames = new Map<string, string[]>();
  private readonly graph = new ModuleGraph();

  private resolvedBySource = new Map<string, string[]>();
  private comesToBySource = new Map<string, string[]>();
  private writtenAsBySource = new Map<string, string[]>();
  private callsIntoBySource = new Map<string, string[]>();
  private comesFromBySource = new Map<string, string[]>();
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
    return this.resolveByWaves(target, () => this.lookup(target));
  }

  /**
   * The object literal `value` ends up being, or null. The route a
   * registration call names often lives on a shared object built in
   * another file, and this is how discovery reads it back.
   */
  resolveObject(value: Node): Node | null {
    const target = factKeyOf(value);
    return this.resolveByWaves(target, () => this.lookupObject(target));
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
    return this.resolveByWaves(target, () => this.lookupWritten(target));
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
      this.resolveByWaves(target, () =>
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

    const origins = this.comesFromBySource.get(nodeId(value)) ?? [];
    const reached = new Set(origins);
    for (const target of this.comesToBySource.get(nodeId(value)) ?? []) {
      for (const entry of this.callsIntoBySource.get(target) ?? []) {
        reached.add(entry);
      }
    }

    const names = namesFrom([...reached], modules);
    if (names.length > 0) {
      return names;
    }
    return origins.some((pair) => namesAPackage(moduleOf(pair))) ? [] : null;
  }

  private resolveByWaves<T>(value: Node, ask: () => T | null): T | null {
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
    for (const target of this.comesToBySource.get(nodeId(value)) ?? []) {
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
    for (const target of this.writtenAsBySource.get(nodeId(value)) ?? []) {
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
    for (const target of this.resolvedBySource.get(nodeId(value)) ?? []) {
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

  /**
   * Run the rules to fixpoint and index `resolves` by its source, so
   * a lookup is a map hit rather than a scan of every derived tuple.
   */
  private derive(): void {
    if (!this.stale) {
      return;
    }
    this.stale = false;
    evaluate(this.db, RESOLUTION_RULES);

    this.resolvedBySource = indexBySource(this.db.facts("resolves"));
    this.comesToBySource = indexBySource(this.db.facts("comesTo"));
    this.writtenAsBySource = indexBySource(this.db.facts("isWrittenAs"));
    this.callsIntoBySource = indexPairsBySource(this.db.facts("callsInto"));
    this.comesFromBySource = indexPairsBySource(this.db.facts("comesFrom"));
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
    if (namesPackage(moduleOf(pair), packages)) {
      names.add(pair.slice(pair.indexOf(PAIR_SEPARATOR) + 1));
    }
  }
  return [...names].sort();
}

/** The module half of a joined module-and-name pair. */
function moduleOf(pair: string): string {
  return pair.slice(0, pair.indexOf(PAIR_SEPARATOR));
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

/** One relation's tuples, grouped by their first column. */
function indexBySource(
  tuples: ReadonlyArray<ReadonlyArray<string | number>>,
): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const tuple of tuples) {
    const source = String(tuple[0]);
    const targets = index.get(source);
    if (targets === undefined) {
      index.set(source, [String(tuple[1])]);
    } else {
      targets.push(String(tuple[1]));
    }
  }
  return index;
}

/**
 * A three-column relation grouped by its first column, with the other
 * two joined so one lookup carries the pair.
 */
function indexPairsBySource(
  tuples: ReadonlyArray<ReadonlyArray<string | number>>,
): Map<string, string[]> {
  return indexBySource(
    tuples.map((tuple) => [
      tuple[0] as string,
      `${tuple[1]}${PAIR_SEPARATOR}${tuple[2]}`,
    ]),
  );
}
