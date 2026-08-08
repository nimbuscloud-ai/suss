// moduleGraph.ts: which files a file imports, and which packages it
// reaches through them.
//
// Asking ts-morph what a module specifier resolves to is expensive: the
// compiler runs full module resolution, project-reference redirects and
// path canonicalisation for every call. The result never changes within
// a run, so every specifier is resolved once and the edge is kept.
//
// Package reachability is a fixpoint over those edges, so the rules
// engine derives it. Reading a file's specifiers is cheap and resolving
// them is not, which decides the shape of the walk: a file whose own
// specifiers already name the package settles it by itself,
// and nothing below it needs resolving.

import { Database, evaluate, lit, rule, variable as v } from "@suss/datalog";

import type { SourceFile } from "ts-morph";

/**
 * `importsFile(f, g)` says f writes a specifier resolving to file g.
 * `importsPackage(f, p)` says one of f's own specifiers is p or a
 * subpath of p. `reachesPackage(f, p)` says p is reachable from f
 * through project files.
 */
const REACH_RULES = [
  rule(
    "reachesPackage",
    [v("f"), v("p")],
    [lit("importsPackage", v("f"), v("p"))],
  ),
  // The already-reached file comes first in the body so that each
  // round's new conclusions bind `g` before the edge relation is
  // consulted, turning what would be a scan of every edge into an
  // indexed lookup of the files importing `g`.
  rule(
    "reachesPackage",
    [v("f"), v("p")],
    [lit("reachesPackage", v("g"), v("p")), lit("importsFile", v("f"), v("g"))],
  ),
];

/** One question: do these files reach any of these packages. */
export interface FileSetQuery {
  sourceFiles: ReadonlyArray<SourceFile>;
  packages: ReadonlyArray<string>;
}

export class ModuleGraph {
  private readonly db = new Database();
  private readonly specifiers = new Map<string, string[]>();
  private readonly importedFiles = new Map<string, SourceFile[]>();
  private readonly settledFor = new Map<string, Set<string>>();
  private stale = false;

  /**
   * The project files this file's import and export specifiers resolve
   * to. Resolved once per file and kept for the rest of the run.
   */
  importedFilesOf(sourceFile: SourceFile): SourceFile[] {
    const filePath = sourceFile.getFilePath();
    const known = this.importedFiles.get(filePath);
    if (known !== undefined) {
      return known;
    }
    const resolved = resolveModuleSpecifiers(sourceFile);
    this.importedFiles.set(filePath, resolved);
    for (const target of resolved) {
      this.assert("importsFile", [filePath, target.getFilePath()]);
    }
    return resolved;
  }

  /**
   * For each of these package sets, which files reach any package in it
   * through project-local imports and re-exports, a file's own imports
   * included. Results come back in the order the sets were given.
   *
   * Every set is answered together because reachability is a fixpoint,
   * and a fixpoint asked twice re-reads what it already concluded. One
   * pass of the rules over the collected edges covers all of them.
   */
  filesReachingAnyPackage(
    fileSets: ReadonlyArray<FileSetQuery>,
  ): ReadonlyArray<ReadonlySet<SourceFile>> {
    for (const { sourceFiles, packages } of fileSets) {
      for (const name of packages) {
        for (const sourceFile of sourceFiles) {
          this.settle(sourceFile, name);
        }
      }
    }
    this.derive();

    return fileSets.map(({ sourceFiles, packages }) => {
      const reaching = new Set<SourceFile>();
      for (const sourceFile of sourceFiles) {
        const filePath = sourceFile.getFilePath();
        if (
          packages.some((name) =>
            this.db.has("reachesPackage", [filePath, name]),
          )
        ) {
          reaching.add(sourceFile);
        }
      }
      return reaching;
    });
  }

  private specifiersOf(sourceFile: SourceFile): string[] {
    const filePath = sourceFile.getFilePath();
    const known = this.specifiers.get(filePath);
    if (known !== undefined) {
      return known;
    }
    const read = readModuleSpecifiers(sourceFile);
    this.specifiers.set(filePath, read);
    return read;
  }

  /**
   * Collect what the rules need in order to settle this file and this
   * package: the edges of every file below it that does not already
   * name the package itself.
   *
   * A file that imports the package stops the walk there. It is reached
   * whatever it imports, so resolving its specifiers would cost the
   * expensive half of the walk for something already known. A file an
   * earlier walk settled stops it for the same reason.
   */
  private settle(root: SourceFile, name: string): void {
    const settled = this.settledOf(name);
    if (settled.has(root.getFilePath())) {
      return;
    }
    const walked = new Set<string>();
    const stack = [root];
    while (stack.length > 0) {
      const current = stack.pop() as SourceFile;
      const currentPath = current.getFilePath();
      if (walked.has(currentPath) || settled.has(currentPath)) {
        continue;
      }
      walked.add(currentPath);
      if (namesPackage(this.specifiersOf(current), name)) {
        this.assert("importsPackage", [currentPath, name]);
        continue;
      }
      stack.push(...this.importedFilesOf(current));
    }
    // Every file the walk reached is reachable from the root, so its
    // own closure is a subset of the one just covered.
    for (const filePath of walked) {
      settled.add(filePath);
    }
  }

  private settledOf(name: string): Set<string> {
    const known = this.settledFor.get(name);
    if (known !== undefined) {
      return known;
    }
    const created = new Set<string>();
    this.settledFor.set(name, created);
    return created;
  }

  private assert(relation: string, tuple: [string, string]): void {
    if (this.db.add(relation, tuple)) {
      this.stale = true;
    }
  }

  private derive(): void {
    if (!this.stale) {
      return;
    }
    this.stale = false;
    evaluate(this.db, REACH_RULES);
  }
}

function readModuleSpecifiers(sourceFile: SourceFile): string[] {
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

function resolveModuleSpecifiers(sourceFile: SourceFile): SourceFile[] {
  const resolved: SourceFile[] = [];
  for (const importDecl of sourceFile.getImportDeclarations()) {
    const target = importDecl.getModuleSpecifierSourceFile();
    if (target !== undefined) {
      resolved.push(target);
    }
  }
  for (const exportDecl of sourceFile.getExportDeclarations()) {
    const target = exportDecl.getModuleSpecifierSourceFile();
    if (target !== undefined) {
      resolved.push(target);
    }
  }
  return resolved;
}

/**
 * Whether any of these module specifiers points at this package. A package
 * name matches itself and any of its subpaths, mirroring how npm
 * packages export sub-paths.
 */
export function namesPackage(
  specifiers: ReadonlyArray<string>,
  name: string,
): boolean {
  return specifiers.some(
    (specifier) => specifier === name || specifier.startsWith(`${name}/`),
  );
}

/** Whether any of these module specifiers points at any of these packages. */
export function namesAnyPackage(
  specifiers: ReadonlyArray<string>,
  names: ReadonlyArray<string>,
): boolean {
  return names.some((name) => namesPackage(specifiers, name));
}
