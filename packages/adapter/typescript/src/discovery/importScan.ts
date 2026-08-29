/**
 * The one import scan.
 *
 * Fifteen copies of "which names did this file import from module X"
 * grew across discovery handlers and packs, and two of them disagreed
 * about aliases (#674). Every question about a file's imports of a
 * module is asked here: which declarations name it, what the named
 * imports are called locally, and which local spellings the default
 * and namespace imports go by. Matching semantics are explicit
 * options, so a caller that accepts subpath specifiers or resolves
 * path-shaped specifiers through the store says so, and one that
 * matches the specifier verbatim stays verbatim.
 */

import path from "node:path";

import { commonDirectoryOf } from "../diagnostics.js";

import type { ImportDeclaration, Project, SourceFile } from "ts-morph";
import type { ResolutionStore } from "../facts/store.js";

export interface ImportScanOptions {
  /**
   * Accept `module/subpath` specifiers beside the exact module, the
   * way `react-dom/client` is still react-dom's surface.
   */
  subpaths?: boolean;
  /** Resolve path-shaped specifiers through the store's module graph. */
  resolution?: ResolutionStore;
}

function specifierMatches(
  specifier: string,
  moduleName: string,
  subpaths: boolean,
): boolean {
  if (specifier === moduleName) {
    return true;
  }
  return subpaths && specifier.startsWith(`${moduleName}/`);
}

/** One named import: how the file spells it, and what it is. */
export interface NamedImport {
  /** The spelling this file binds, the alias when there is one. */
  local: string;
  /** The name the module exports it as. */
  canonical: string;
  /** The specifier as written, for a caller that reads sub-paths. */
  specifier: string;
}

/** Every named import of these modules, aliases resolved. */
export function namedImportsOf(
  sourceFile: SourceFile,
  modules: readonly string[],
  options: ImportScanOptions = {},
): NamedImport[] {
  const found: NamedImport[] = [];
  for (const decl of importDeclarationsOf(sourceFile, modules, options)) {
    const specifier = decl.getModuleSpecifierValue();
    for (const named of decl.getNamedImports()) {
      const canonical = named.getName();
      found.push({
        local: named.getAliasNode()?.getText() ?? canonical,
        canonical,
        specifier,
      });
    }
  }
  return found;
}

/**
 * Local spelling to canonical exported name, for every named import
 * of these modules. `import { Get as HttpGet }` yields HttpGet -> Get.
 */
export function importedNamesOf(
  sourceFile: SourceFile,
  modules: readonly string[],
  options: ImportScanOptions = {},
): Map<string, string> {
  const names = new Map<string, string>();
  for (const one of namedImportsOf(sourceFile, modules, options)) {
    names.set(one.local, one.canonical);
  }
  return names;
}

/** The local spellings of default and namespace imports of these modules. */
export function importedRootsOf(
  sourceFile: SourceFile,
  modules: readonly string[],
  options: ImportScanOptions = {},
): Set<string> {
  const roots = new Set<string>();
  for (const decl of importDeclarationsOf(sourceFile, modules, options)) {
    const defaultImport = decl.getDefaultImport()?.getText();
    if (defaultImport !== undefined) {
      roots.add(defaultImport);
    }
    const namespaceImport = decl.getNamespaceImport()?.getText();
    if (namespaceImport !== undefined) {
      roots.add(namespaceImport);
    }
  }
  return roots;
}

/** Every import declaration in the file that names one of `modules`. */
export function importDeclarationsOf(
  sourceFile: SourceFile,
  modules: readonly string[],
  options: ImportScanOptions = {},
): ImportDeclaration[] {
  const found: ImportDeclaration[] = [];
  for (const moduleName of modules) {
    for (const decl of matchingImportDeclarations(
      sourceFile,
      moduleName,
      options.resolution,
      options.subpaths === true,
    )) {
      if (!found.includes(decl)) {
        found.push(decl);
      }
    }
  }
  return found;
}

/**
 * This file's own import declarations that name `importModule`.
 *
 * A bare specifier ("axios") is compared as written: two files
 * spelling a package's name the same way mean the same package by
 * definition. A path-shaped specifier (starts with "." or "/") names
 * a location relative to wherever it's written, so a factory
 * configured as "./apiClient" and a file importing it as
 * "../apiClient" can point at the same file without sharing a single
 * character in common; only resolving both to the file they point at
 * decides whether they do.
 *
 * Falls back to the literal comparison when a path-shaped specifier
 * doesn't resolve to a project file at all, rather than answering
 * "nothing imports this": a pattern naming a module that was never
 * meant to resolve (a pack's own test fixture, a module outside the
 * project the type checker can't place) still has calls to match by
 * the text its own file states, the way this pack always has.
 */
export function matchingImportDeclarations(
  sourceFile: SourceFile,
  importModule: string,
  resolution?: ResolutionStore,
  subpaths = false,
): ImportDeclaration[] {
  const target = isPathShapedSpecifier(importModule)
    ? resolvedModuleFile(sourceFile.getProject(), importModule, resolution)
    : null;
  if (target !== null) {
    return sourceFile
      .getImportDeclarations()
      .filter((decl) => decl.getModuleSpecifierSourceFile() === target);
  }
  return sourceFile
    .getImportDeclarations()
    .filter((decl) =>
      specifierMatches(decl.getModuleSpecifierValue(), importModule, subpaths),
    );
}

/** A relative or absolute specifier points at a location rather than a package. */
function isPathShapedSpecifier(specifier: string): boolean {
  return specifier.startsWith(".") || specifier.startsWith("/");
}

/**
 * Resolved paths, not SourceFile nodes: a caller can reuse the same
 * ts-morph Project across separate runs (a rebuilt fixture in a test,
 * an editor reusing one project between edits), and a Project doing
 * that removes and re-adds files at the same path rather than staying
 * put, so a node cached from an earlier run reports "removed or
 * forgotten" once ts-morph notices the swap. A path never goes stale;
 * looking the current node up by it, fresh, on every hit does.
 *
 * Scoped to the resolution store rather than the project for the same
 * reason: one store is built per extraction run and thrown away after,
 * so nothing here outlives the run whose project it was resolved
 * against. A caller with no store gets no caching, and resolves fresh
 * every time; that only costs a run without cross-file resolution
 * asked for anyway, which had nothing to compose against here either.
 */
const resolvedModuleFileCache = new WeakMap<
  ResolutionStore,
  Map<string, string | null>
>();

/**
 * The project file a path-shaped `importModule` names, resolved once
 * from the project's own root. A relative specifier has no meaning by
 * itself, only relative to wherever it's written, so a pack config's
 * own module path is anchored the same way regardless of which file
 * ends up asking about it, rather than on where that file happens to
 * be.
 */
export function resolvedModuleFile(
  project: Project,
  importModule: string,
  resolution: ResolutionStore | undefined,
): SourceFile | null {
  if (resolution === undefined) {
    return projectFileNamedBy(project, importModule);
  }
  let perRun = resolvedModuleFileCache.get(resolution);
  if (perRun === undefined) {
    perRun = new Map();
    resolvedModuleFileCache.set(resolution, perRun);
  }
  const cachedPath = perRun.get(importModule);
  if (cachedPath !== undefined) {
    return cachedPath === null
      ? null
      : (project.getSourceFile(cachedPath) ?? null);
  }
  const resolved = projectFileNamedBy(project, importModule);
  perRun.set(importModule, resolved?.getFilePath() ?? null);
  return resolved;
}

/**
 * The project's own source file `specifier` names, resolved from the
 * common directory every loaded file is under (the project root
 * when there's a tsconfig; the same anchor an in-memory fixture
 * project's files are under otherwise). Declaration files are left
 * out of both that directory and the candidate set: a factory is a
 * project's own function, never a `.d.ts`, and a global type root
 * living outside the project tree would otherwise widen the shared
 * directory to somewhere the specifier was never meant to resolve
 * from.
 */
function projectFileNamedBy(
  project: Project,
  specifier: string,
): SourceFile | null {
  const files = project
    .getSourceFiles()
    .filter((sf) => !sf.isDeclarationFile());
  const root = commonDirectoryOf(files.map((sf) => sf.getFilePath())) ?? "/";
  const target = withoutSourceExtension(path.resolve(root, specifier));
  for (const candidate of files) {
    if (withoutSourceExtension(candidate.getFilePath()) === target) {
      return candidate;
    }
  }
  return null;
}

/**
 * Strips a source extension and a trailing implicit-index segment, so
 * "./apiClient" as configured and "/apiClient/index.ts" as resolved
 * compare equal the same way a bundler's own resolution treats them.
 */
function withoutSourceExtension(filePath: string): string {
  return filePath
    .replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "")
    .replace(/\/index$/, "");
}
