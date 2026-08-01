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
import { RESOLUTION_RULES as SHARED_RULES } from "@suss/resolution";

import { isFunctionRoot } from "../discovery/shared.js";
import {
  createNodeTable,
  extractFileFacts,
  type NodeTable,
  nodeId,
} from "./extract.js";

import type { TransparentWrapper } from "@suss/extractor";
import type { Node, SourceFile } from "ts-morph";

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
        next.push(...referencedProjectFiles(sourceFile));
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
