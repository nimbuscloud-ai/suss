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

import { Node, type SourceFile } from "ts-morph";

import { atom, FactDb, rule, v } from "./engine.js";
import {
  createNodeTable,
  extractFileFacts,
  extractModuleFacts,
  type NodeTable,
  nodeId,
} from "./extract.js";

/** A library wrapper a pack declares as transparent. */
export interface TransparentWrapper {
  /** Callee text as written, e.g. "Sentry.wrapHandler". */
  callee: string;
  /** Which argument is the wrapped function. */
  argument: number;
}

const RESOLUTION_RULES = [
  // A function resolves to itself; every chain ends here.
  rule(atom("resolves", v("f"), v("f")), atom("func", v("f"))),

  // Aliasing: const x = y, or an identifier referencing a declaration.
  rule(
    atom("resolves", v("x"), v("z")),
    atom("binds", v("x"), v("y")),
    atom("resolves", v("y"), v("z")),
  ),

  // An import resolves to what the module exports under that name.
  rule(
    atom("resolves", v("x"), v("z")),
    atom("imports", v("x"), v("m"), v("n")),
    atom("moduleExport", v("m"), v("n"), v("value")),
    atom("resolves", v("value"), v("z")),
  ),

  // What a module exports: directly, or through re-export chains.
  rule(
    atom("moduleExport", v("m"), v("n"), v("value")),
    atom("exportsAs", v("m"), v("n"), v("value")),
  ),
  rule(
    atom("moduleExport", v("m"), v("n"), v("value")),
    atom("reExports", v("m"), v("n"), v("m2"), v("n2")),
    atom("moduleExport", v("m2"), v("n2"), v("value")),
  ),
  rule(
    atom("moduleExport", v("m"), v("n"), v("value")),
    atom("reExportsAll", v("m"), v("m2")),
    atom("moduleExport", v("m2"), v("n"), v("value")),
  ),

  // f.bind(...) resolves to whatever f resolves to.
  rule(
    atom("resolves", v("r"), v("h")),
    atom("bindCall", v("r"), v("t")),
    atom("resolves", v("t"), v("h")),
  ),

  // Wrapper transparency, derived: calling a factory that returns a
  // function which calls its parameter k resolves to argument k.
  rule(
    atom("returnsFunc", v("f"), v("g")),
    atom("returnsValue", v("f"), v("value")),
    atom("resolves", v("value"), v("g")),
  ),
  // A call made by a nested closure counts as made by the function
  // that declares it; the closure runs as part of that function.
  rule(
    atom("bodyCallsDeep", v("f"), v("c")),
    atom("bodyCalls", v("f"), v("c")),
  ),
  rule(
    atom("bodyCallsDeep", v("f"), v("c")),
    atom("containsFn", v("f"), v("g")),
    atom("bodyCallsDeep", v("g"), v("c")),
  ),
  rule(
    atom("unwraps", v("f"), v("k")),
    atom("returnsFunc", v("f"), v("g")),
    atom("bodyCallsDeep", v("g"), v("c")),
    atom("binds", v("c"), v("p")),
    atom("paramOf", v("f"), v("k"), v("p")),
  ),

  // Argument flow: which parameter a value traces back to. Directly
  // (an identifier bound to the parameter), or through a call to
  // another unwrapping factory. This is what lets
  // `createProtected(h) { return service.withAuth(h); }` unwrap:
  // the returned call passes h through withAuth, which unwraps.
  rule(
    atom("flowsToParam", v("x"), v("p")),
    atom("binds", v("x"), v("p")),
    atom("paramOf", v("anyF"), v("anyK"), v("p")),
  ),
  rule(
    atom("flowsToParam", v("r"), v("p")),
    atom("call", v("r"), v("c")),
    atom("resolves", v("c"), v("f")),
    atom("unwraps", v("f"), v("k")),
    atom("callArg", v("r"), v("k"), v("a")),
    atom("flowsToParam", v("a"), v("p")),
  ),
  rule(
    atom("unwraps", v("f"), v("k")),
    atom("returnsValue", v("f"), v("value")),
    atom("flowsToParam", v("value"), v("p")),
    atom("paramOf", v("f"), v("k"), v("p")),
  ),
  rule(
    atom("resolves", v("r"), v("h")),
    atom("call", v("r"), v("c")),
    atom("resolves", v("c"), v("f")),
    atom("unwraps", v("f"), v("k")),
    atom("callArg", v("r"), v("k"), v("a")),
    atom("resolves", v("a"), v("h")),
  ),

  // Wrapper transparency, declared: a pack says this callee wraps
  // argument k, no matter what its implementation looks like.
  rule(
    atom("resolves", v("r"), v("h")),
    atom("calleeName", v("r"), v("n")),
    atom("unwrapsByName", v("n"), v("k")),
    atom("callArg", v("r"), v("k"), v("a")),
    atom("resolves", v("a"), v("h")),
  ),

  // Which packages a file reaches through its imports. Chains pass
  // through project files (they have importsModule facts of their
  // own); a package name terminates the chain.
  rule(
    atom("reachesModule", v("file"), v("m")),
    atom("importsModule", v("file"), v("m")),
  ),
  rule(
    atom("reachesModule", v("file"), v("m")),
    atom("importsModule", v("file"), v("via")),
    atom("reachesModule", v("via"), v("m")),
  ),
];

/**
 * How many module hops a query follows when pulling in facts. Deep
 * enough for barrels of barrels; a bound so a pathological import
 * graph stays cheap.
 */
const MAX_MODULE_HOPS = 6;

export class ResolutionStore {
  private readonly db = new FactDb();
  private readonly table: NodeTable = createNodeTable();
  private readonly fullyExtracted = new Set<string>();
  private readonly moduleExtracted = new Set<string>();

  constructor(wrappers: TransparentWrapper[] = []) {
    this.db.setRules(RESOLUTION_RULES);
    for (const wrapper of wrappers) {
      this.db.add("unwrapsByName", wrapper.callee, String(wrapper.argument));
    }
  }

  /**
   * The function `value` resolves to, or null when no chain reaches
   * one. The result is a ts-morph node in whatever file the function
   * actually lives.
   */
  resolveCallable(value: Node): Node | null {
    this.ensureFile(value.getSourceFile());

    const results = this.db.query("resolves", [nodeId(value), null]);
    for (const tuple of results) {
      const resolved = this.table.byId.get(tuple[1] as string);
      if (resolved !== undefined && resolved !== value) {
        return resolved;
      }
      if (resolved === value && isFunction(value)) {
        return value;
      }
    }
    return null;
  }

  /** Whether `file` reaches any of `packages` through its imports. */
  importsTransitively(sourceFile: SourceFile, packages: string[]): boolean {
    this.ensureModuleFacts(sourceFile, 0);
    const filePath = sourceFile.getFilePath();
    return packages.some(
      (packageName) =>
        this.db.has("reachesModule", [filePath, packageName]) ||
        this.reachesSubpath(filePath, packageName),
    );
  }

  /** "@workweek/aws/sqs" reaches "@aws-sdk/client-sqs/submodule" too. */
  private reachesSubpath(filePath: string, packageName: string): boolean {
    const prefix = `${packageName}/`;
    return this.db
      .query("reachesModule", [filePath, null])
      .some((tuple) => (tuple[1] as string).startsWith(prefix));
  }

  /**
   * Extract full facts for a file and, transitively, for the project
   * files its imports and re-exports point at. Resolution chains can
   * only follow edges into files whose facts exist.
   */
  private ensureFile(sourceFile: SourceFile, depth = 0): void {
    const filePath = sourceFile.getFilePath();
    if (this.fullyExtracted.has(filePath)) {
      return;
    }
    this.fullyExtracted.add(filePath);
    this.moduleExtracted.add(filePath);

    extractFileFacts(this.db, this.table, sourceFile);

    if (depth >= MAX_MODULE_HOPS) {
      return;
    }
    for (const referenced of referencedProjectFiles(sourceFile)) {
      this.ensureFile(referenced, depth + 1);
    }
  }

  /** The light tier: import and re-export facts only. */
  private ensureModuleFacts(sourceFile: SourceFile, depth: number): void {
    const filePath = sourceFile.getFilePath();
    if (
      this.moduleExtracted.has(filePath) ||
      this.fullyExtracted.has(filePath)
    ) {
      return;
    }
    this.moduleExtracted.add(filePath);

    extractModuleFacts(this.db, sourceFile);

    if (depth >= MAX_MODULE_HOPS) {
      return;
    }
    for (const referenced of referencedProjectFiles(sourceFile)) {
      this.ensureModuleFacts(referenced, depth + 1);
    }
  }
}

function isFunction(node: Node): boolean {
  return (
    Node.isFunctionDeclaration(node) ||
    Node.isFunctionExpression(node) ||
    Node.isArrowFunction(node) ||
    Node.isMethodDeclaration(node)
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
