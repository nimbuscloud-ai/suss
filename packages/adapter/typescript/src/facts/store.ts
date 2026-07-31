// store.ts - the resolution store and its two questions.
//
// resolveCallable: which function does this value resolve to, through
// any depth of aliasing, imports, re-export barrels, wrapper
// factories, and .bind.
//
// importsTransitively: does this file reach any of these packages
// through its imports, following project-local re-export chains. The
// per-file import check is defeated by a barrel package that
// re-exports an SDK; this one is not.
//
// Facts are extracted per file on demand and only along the module
// edges a query follows, so cost tracks the indirection present, not
// project size.

import { Database, evaluate, lit, rule, variable as v } from "@suss/datalog";

import { isFunctionRoot } from "../discovery/shared.js";
import {
  createNodeTable,
  extractFileFacts,
  type NodeTable,
  nodeId,
} from "./extract.js";

import type { TransparentWrapper } from "@suss/extractor";
import type { Node, SourceFile } from "ts-morph";

const RESOLUTION_RULES = [
  // A function resolves to itself; every chain ends here.
  rule("resolves", [v("f"), v("f")], [lit("func", v("f"))]),

  // Aliasing: const x = y, or an identifier referencing a declaration.
  rule(
    "resolves",
    [v("x"), v("z")],
    [lit("binds", v("x"), v("y")), lit("resolves", v("y"), v("z"))],
  ),

  // An import resolves to what the module exports under that name.
  rule(
    "resolves",
    [v("x"), v("z")],
    [
      lit("imports", v("x"), v("m"), v("n")),
      lit("moduleExport", v("m"), v("n"), v("value")),
      lit("resolves", v("value"), v("z")),
    ],
  ),

  // What a module exports: directly, or through re-export chains.
  rule(
    "moduleExport",
    [v("m"), v("n"), v("value")],
    [lit("exportsAs", v("m"), v("n"), v("value"))],
  ),
  rule(
    "moduleExport",
    [v("m"), v("n"), v("value")],
    [
      lit("reExports", v("m"), v("n"), v("m2"), v("n2")),
      lit("moduleExport", v("m2"), v("n2"), v("value")),
    ],
  ),
  rule(
    "moduleExport",
    [v("m"), v("n"), v("value")],
    [
      lit("reExportsAll", v("m"), v("m2")),
      lit("moduleExport", v("m2"), v("n"), v("value")),
    ],
  ),

  // f.bind(...) resolves to whatever f resolves to.
  rule(
    "resolves",
    [v("r"), v("h")],
    [lit("bindCall", v("r"), v("t")), lit("resolves", v("t"), v("h"))],
  ),

  // Wrapper transparency, derived: calling a factory that returns a
  // function which calls its parameter k resolves to argument k.
  rule(
    "returnsFunc",
    [v("f"), v("g")],
    [
      lit("returnsValue", v("f"), v("value")),
      lit("resolves", v("value"), v("g")),
    ],
  ),
  // A call made by a nested closure counts as made by the function
  // that declares it; the closure runs as part of that function.
  rule("bodyCallsDeep", [v("f"), v("c")], [lit("bodyCalls", v("f"), v("c"))]),
  rule(
    "bodyCallsDeep",
    [v("f"), v("c")],
    [lit("containsFn", v("f"), v("g")), lit("bodyCallsDeep", v("g"), v("c"))],
  ),
  rule(
    "unwraps",
    [v("f"), v("k")],
    [
      lit("returnsFunc", v("f"), v("g")),
      lit("bodyCallsDeep", v("g"), v("c")),
      lit("binds", v("c"), v("p")),
      lit("paramOf", v("f"), v("k"), v("p")),
    ],
  ),

  // Argument flow: which parameter a value traces back to. Directly
  // (an identifier bound to the parameter), or through a call to
  // another unwrapping factory. This is what lets
  // `createProtected(h) { return service.withAuth(h); }` unwrap:
  // the returned call passes h through withAuth, which unwraps.
  rule(
    "flowsToParam",
    [v("x"), v("p")],
    [
      lit("binds", v("x"), v("p")),
      lit("paramOf", v("anyF"), v("anyK"), v("p")),
    ],
  ),
  rule(
    "flowsToParam",
    [v("r"), v("p")],
    [
      lit("call", v("r"), v("c")),
      lit("resolves", v("c"), v("f")),
      lit("unwraps", v("f"), v("k")),
      lit("callArg", v("r"), v("k"), v("a")),
      lit("flowsToParam", v("a"), v("p")),
    ],
  ),
  rule(
    "unwraps",
    [v("f"), v("k")],
    [
      lit("returnsValue", v("f"), v("value")),
      lit("flowsToParam", v("value"), v("p")),
      lit("paramOf", v("f"), v("k"), v("p")),
    ],
  ),
  rule(
    "resolves",
    [v("r"), v("h")],
    [
      lit("call", v("r"), v("c")),
      lit("resolves", v("c"), v("f")),
      lit("unwraps", v("f"), v("k")),
      lit("callArg", v("r"), v("k"), v("a")),
      lit("resolves", v("a"), v("h")),
    ],
  ),

  // Wrapper transparency, declared: a pack says this callee wraps
  // argument k, no matter what its implementation looks like.
  rule(
    "resolves",
    [v("r"), v("h")],
    [
      lit("calleeName", v("r"), v("n")),
      lit("unwrapsByName", v("n"), v("k")),
      lit("callArg", v("r"), v("k"), v("a")),
      lit("resolves", v("a"), v("h")),
    ],
  ),
];

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
  private readonly gateAnswers = new Map<string, Map<string, boolean>>();

  private resolvedBySource = new Map<string, string[]>();
  private stale = true;

  constructor(wrappers: TransparentWrapper[] = []) {
    for (const wrapper of wrappers) {
      this.db.add("unwrapsByName", [wrapper.callee, String(wrapper.argument)]);
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
    let frontier = [value.getSourceFile()];
    for (let hop = 0; hop <= MAX_MODULE_HOPS; hop++) {
      const next: SourceFile[] = [];
      for (const sourceFile of frontier) {
        next.push(...this.extractFile(sourceFile));
      }
      const found = this.lookup(value);
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
   * Whether `file` reaches any of `packages` through its imports,
   * following project-local re-export chains.
   *
   * A walk rather than a rule: the answer is one boolean per file, and
   * deriving the full reachable-module relation for every file in a
   * large repo costs far more than the question is worth.
   */
  importsTransitively(sourceFile: SourceFile, packages: string[]): boolean {
    const gateKey = JSON.stringify(packages);
    let answers = this.gateAnswers.get(gateKey);
    if (answers === undefined) {
      answers = new Map();
      this.gateAnswers.set(gateKey, answers);
    }

    const cached = answers.get(sourceFile.getFilePath());
    if (cached !== undefined) {
      return cached;
    }

    const visited = new Set<string>();
    const queue = [sourceFile];
    while (queue.length > 0) {
      const current = queue.pop() as SourceFile;
      const currentPath = current.getFilePath();
      if (visited.has(currentPath)) {
        continue;
      }
      visited.add(currentPath);

      if (answers.get(currentPath) === true) {
        answers.set(sourceFile.getFilePath(), true);
        return true;
      }
      if (matchesAnyGate(moduleSpecifiers(current), packages)) {
        answers.set(currentPath, true);
        answers.set(sourceFile.getFilePath(), true);
        return true;
      }
      queue.push(...referencedProjectFiles(current));
    }

    // Nothing in the closure reaches a gate, so every file walked has
    // the same answer: its own reachable set is a subset of this one.
    for (const walked of visited) {
      answers.set(walked, false);
    }
    return false;
  }

  private lookup(value: Node): Node | null {
    this.derive();
    for (const target of this.resolvedBySource.get(nodeId(value)) ?? []) {
      const resolved = this.table.byId.get(target);
      if (resolved !== undefined && resolved !== value) {
        return resolved;
      }
      if (resolved === value && isFunctionRoot(value)) {
        return value;
      }
    }
    return null;
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

    this.resolvedBySource = new Map();
    for (const tuple of this.db.facts("resolves")) {
      const source = String(tuple[0]);
      const targets = this.resolvedBySource.get(source);
      if (targets === undefined) {
        this.resolvedBySource.set(source, [String(tuple[1])]);
      } else {
        targets.push(String(tuple[1]));
      }
    }
  }

  /** Extract a file if new, and report the project files it points at. */
  private extractFile(sourceFile: SourceFile): SourceFile[] {
    const filePath = sourceFile.getFilePath();
    if (this.fullyExtracted.has(filePath)) {
      return [];
    }
    this.fullyExtracted.add(filePath);
    this.stale = true;
    extractFileFacts(this.db, this.table, sourceFile);
    return referencedProjectFiles(sourceFile);
  }
}

function moduleSpecifiers(sourceFile: SourceFile): string[] {
  const specifiers: string[] = [];
  for (const importDecl of sourceFile.getImportDeclarations()) {
    specifiers.push(importDecl.getModuleSpecifierValue());
  }
  for (const exportDecl of sourceFile.getExportDeclarations()) {
    const specifier = exportDecl.getModuleSpecifierValue();
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}

/** A gate matches the package itself and any of its subpaths. */
function matchesAnyGate(specifiers: string[], gates: string[]): boolean {
  return specifiers.some((specifier) =>
    gates.some(
      (gate) => specifier === gate || specifier.startsWith(`${gate}/`),
    ),
  );
}

function referencedProjectFiles(sourceFile: SourceFile): SourceFile[] {
  const referenced: SourceFile[] = [];
  for (const importDecl of sourceFile.getImportDeclarations()) {
    const resolved = importDecl.getModuleSpecifierSourceFile();
    if (resolved !== undefined) {
      referenced.push(resolved);
    }
  }
  for (const exportDecl of sourceFile.getExportDeclarations()) {
    const resolved = exportDecl.getModuleSpecifierSourceFile();
    if (resolved !== undefined) {
      referenced.push(resolved);
    }
  }
  return referenced;
}
