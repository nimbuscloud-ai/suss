/**
 * Picks the files a run walks, and gets the compiler ahead of the
 * import graph before anything asks it a question.
 *
 * `createLazyProject` reads the tsconfig's file list and keeps the
 * files whose imports match some active pack's `requiresImport` gate.
 * Those candidates are what the run walks; everything else is loaded
 * later, one file at a time, by `lazyAddSourceFile` when symbol
 * resolution points at it.
 *
 * The rest of the module is about load order. TypeScript follows a
 * re-export chain by recursing, so a barrel chain a few hundred files
 * deep runs the call stack out. `loadImportGraphsDepthFirst` loads each
 * file after everything it imports. The README says why that matters.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { type Project, type SourceFile, ts } from "ts-morph";

import { namesAnyPackage } from "../facts/moduleGraph.js";
import {
  collectPackGates,
  collectPackMarks,
  packIsUngated,
} from "./preFilter.js";

import type { PatternPack } from "@suss/extractor";

export type { Project } from "ts-morph";

export interface LazyProjectInit {
  /** Files matching a pack's gate. The run walks these and only these. */
  candidatePaths: string[];
  /** Every file in the tsconfig include set, loaded or not. */
  projectFileSet: ReadonlySet<string>;
}

export async function createLazyProject(
  tsConfigFilePath: string,
  packs: ReadonlyArray<PatternPack>,
): Promise<LazyProjectInit> {
  const parsed = parseTsconfig(tsConfigFilePath);
  const allFiles = parsed.fileNames;
  const candidates = await selectCandidateFiles(
    allFiles,
    packs,
    parsed.options,
  );

  return {
    candidatePaths: candidates,
    projectFileSet: new Set(allFiles),
  };
}

/** Reads no source, so a cache hit never pays for the bootstrap. */
export function readTsconfigFileList(tsConfigFilePath: string): string[] {
  return parseTsconfig(tsConfigFilePath).fileNames;
}

/**
 * `addSourceFileAtPath` runs even when `getSourceFile` already returns
 * the file. Symbol resolution can produce a SourceFile without putting it
 * in `project.getSourceFiles()`, and a pass that enumerates the project
 * list would then miss it.
 */
export function lazyAddSourceFile(
  project: Project,
  projectFileSet: ReadonlySet<string>,
  filePath: string,
): SourceFile | null {
  if (!projectFileSet.has(filePath)) {
    return null;
  }
  try {
    return project.addSourceFileAtPath(filePath);
  } catch {
    return null;
  }
}

/**
 * Load everything a file imports, each file before the files that
 * import it. The package README says why the order matters.
 */
export function loadImportGraphDepthFirst(root: SourceFile): void {
  loadImportGraphsDepthFirst([root]);
}

/**
 * Call this after the walked-file list is settled. A file arriving
 * before the list is taken gets walked for units too, which changes
 * what the run reports.
 */
export function loadImportGraphsDepthFirst(
  roots: ReadonlyArray<SourceFile>,
): DeepImportGraphs {
  const first = roots[0];
  if (first === undefined) {
    return { deepRoots: [] };
  }

  return loadImportGraphsDepthFirstFromPaths(
    first.getProject(),
    roots.map((root) => root.getFilePath()),
  );
}

/**
 * The same walk from bare paths, for roots not yet in the project. The
 * walk's postorder puts each root after everything it imports, so the
 * roots themselves land in the project last. The compiler then takes
 * its program files in that order, and every file it processes finds
 * its imports already done instead of descending the whole chain.
 */
export function loadImportGraphsDepthFirstFromPaths(
  project: Project,
  rootPaths: ReadonlyArray<string>,
): DeepImportGraphs {
  if (rootPaths.length === 0) {
    return { deepRoots: [] };
  }

  const host = project.getModuleResolutionHost();
  const options = project.getCompilerOptions();

  const resolvedByFile = specifierCacheFor(project);

  const specifierPaths = (filePath: string): string[] => {
    const already = resolvedByFile.get(filePath);
    if (already !== undefined) {
      return already;
    }

    const paths = readSpecifierPaths(project, filePath, options, host);
    resolvedByFile.set(filePath, paths);
    return paths;
  };

  const chainDepth = settledDepthsFor(project);
  const visited = new Set<string>();
  const loadOrder: string[] = [];
  for (const rootPath of rootPaths) {
    if (visited.has(rootPath) || chainDepth.has(rootPath)) {
      continue;
    }

    visited.add(rootPath);
    const stack: Array<{ path: string; deps: string[]; next: number }> = [
      { path: rootPath, deps: specifierPaths(rootPath), next: 0 },
    ];
    while (stack.length > 0) {
      const top = stack[stack.length - 1] as (typeof stack)[number];
      const dep = top.deps[top.next];
      if (dep !== undefined) {
        top.next += 1;
        if (!visited.has(dep) && !chainDepth.has(dep)) {
          visited.add(dep);
          stack.push({ path: dep, deps: specifierPaths(dep), next: 0 });
        }
        continue;
      }

      stack.pop();
      loadOrder.push(top.path);
      // A cycle leaves a dependency's depth unset. Zero is right, since
      // going round the cycle again adds nothing to the depth.
      let deepest = 0;
      for (const path of top.deps) {
        deepest = Math.max(deepest, chainDepth.get(path) ?? 0);
      }
      chainDepth.set(top.path, deepest + 1);
    }
  }

  let loadedAnything = false;
  for (const filePath of loadOrder) {
    if (project.getSourceFile(filePath) !== undefined) {
      continue;
    }
    try {
      project.addSourceFileAtPath(filePath);
      loadedAnything = true;
    } catch {
      // The resolver gave a path the file system does not have.
    }
  }

  // A run with nothing left to load already had the whole graph, in an
  // order the compiler could walk.
  if (!loadedAnything) {
    return { deepRoots: [] };
  }

  const deepRoots: SourceFile[] = [];
  for (const rootPath of rootPaths) {
    if ((chainDepth.get(rootPath) ?? 0) < WARM_DEPTH) {
      continue;
    }

    const loaded = project.getSourceFile(rootPath);
    if (loaded !== undefined) {
      deepRoots.push(loaded);
    }
  }
  return { deepRoots };
}

export interface DeepImportGraphs {
  /** Roots too deep for the checker to walk on its own. */
  deepRoots: SourceFile[];
}

/** Well under the depth the checker handles alone, far above a barrel. */
const WARM_DEPTH = 100;

/** Read from the load walk's record, never from the checker. */
export function importedFilePathsOf(
  project: Project,
  filePath: string,
): string[] {
  const cache = specifierCacheFor(project);
  const already = cache.get(filePath);
  if (already !== undefined) {
    return already;
  }

  const paths = readSpecifierPaths(
    project,
    filePath,
    project.getCompilerOptions(),
    project.getModuleResolutionHost(),
  );
  cache.set(filePath, paths);
  return paths;
}

/** Keyed on the project, so two projects never share results. */
function specifierCacheFor(project: Project): Map<string, string[]> {
  const existing = specifiersByProject.get(project);
  if (existing !== undefined) {
    return existing;
  }

  const fresh = new Map<string, string[]>();
  specifiersByProject.set(project, fresh);
  return fresh;
}

const specifiersByProject = new WeakMap<Project, Map<string, string[]>>();

function settledDepthsFor(project: Project): Map<string, number> {
  const existing = depthsByProject.get(project);
  if (existing !== undefined) {
    return existing;
  }

  const fresh = new Map<string, number>();
  depthsByProject.set(project, fresh);
  return fresh;
}

const depthsByProject = new WeakMap<Project, Map<string, number>>();

function readSpecifierPaths(
  project: Project,
  filePath: string,
  options: ts.CompilerOptions,
  host: ts.ModuleResolutionHost,
): string[] {
  const text = readFileText(project, filePath);
  if (text === null) {
    return [];
  }

  const scanned = ts.preProcessFile(text, true, true);
  const paths: string[] = [];
  for (const imported of scanned.importedFiles) {
    const resolved = ts.resolveModuleName(
      imported.fileName,
      filePath,
      options,
      host,
    ).resolvedModule?.resolvedFileName;
    if (resolved !== undefined && !resolved.includes("/node_modules/")) {
      paths.push(resolved);
    }
  }
  return paths;
}

function readFileText(project: Project, filePath: string): string | null {
  const loaded = project.getSourceFile(filePath);
  if (loaded !== undefined) {
    return loaded.getFullText();
  }
  try {
    return project.getFileSystem().readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function parseTsconfig(tsConfigFilePath: string): {
  fileNames: string[];
  options: ts.CompilerOptions;
} {
  const configFile = ts.readConfigFile(tsConfigFilePath, ts.sys.readFile);
  if (configFile.error !== undefined) {
    return { fileNames: [], options: {} };
  }
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(tsConfigFilePath),
    /*existingOptions*/ undefined,
    tsConfigFilePath,
  );
  return { fileNames: parsed.fileNames, options: parsed.options };
}

interface FileImports {
  path: string;
  importedModules: string[];
  /** Which of the packs' marks this file's own text contains. */
  marked: boolean;
}

async function selectCandidateFiles(
  allFiles: ReadonlyArray<string>,
  packs: ReadonlyArray<PatternPack>,
  options: ts.CompilerOptions,
): Promise<string[]> {
  // One pack matching every file leaves nothing to pre-filter.
  const ungatedExists = packs.some(packIsUngated);
  if (ungatedExists) {
    return [...allFiles];
  }
  const gates = collectAllGates(packs);
  const marks = collectAllMarks(packs);
  if (gates.length === 0 && marks.length === 0) {
    return [];
  }

  const fileImports = await readImportsConcurrently(allFiles, marks);
  const matched = new Set<string>();
  for (const { path: p, importedModules, marked } of fileImports) {
    if (marked || namesAnyPackage(importedModules, gates)) {
      matched.add(p);
    }
  }

  addImportersOfMatches(fileImports, matched, options);
  return allFiles.filter((p) => matched.has(p));
}

/**
 * A consumer can reach a gated package through a project module of its
 * own, a wrapper around an HTTP client say, and a file selected only by
 * its direct imports skips that consumer before parsing (#181). So a
 * file that imports a selected file is selected too, to a fixpoint.
 * Only relative specifiers and tsconfig path aliases resolve here,
 * against the include set alone, with no filesystem probing: a
 * specifier this cannot resolve either leaves the project, where the
 * direct gate already decided, or goes through a mapping the compiler
 * would need, and then the file loads later the way it always has.
 */
function addImportersOfMatches(
  fileImports: ReadonlyArray<FileImports>,
  matched: Set<string>,
  options: ts.CompilerOptions,
): void {
  const resolve = internalSpecifierResolver(
    fileImports.map((fi) => fi.path),
    options,
  );
  const importersOf = new Map<string, string[]>();
  for (const { path: from, importedModules } of fileImports) {
    for (const spec of importedModules) {
      const target = resolve(from, spec);
      if (target === null || target === from) {
        continue;
      }
      const list = importersOf.get(target);
      if (list === undefined) {
        importersOf.set(target, [from]);
      } else {
        list.push(from);
      }
    }
  }

  const queue = [...matched];
  while (queue.length > 0) {
    const target = queue.pop() as string;
    for (const importer of importersOf.get(target) ?? []) {
      if (!matched.has(importer)) {
        matched.add(importer);
        queue.push(importer);
      }
    }
  }
}

/**
 * Resolve a specifier to a file in the include set, or null, with the
 * compiler's own resolver, so every specifier resolves the way the
 * program will resolve it later. An in-memory string probe measured
 * the same wall time on a 12k-file tree and misses workspace packages.
 */
function internalSpecifierResolver(
  files: ReadonlyArray<string>,
  options: ts.CompilerOptions,
): (fromFile: string, spec: string) => string | null {
  const fileSet = new Set(files);
  const cache = ts.createModuleResolutionCache(
    ts.sys.getCurrentDirectory(),
    (name) => name,
    options,
  );
  return (fromFile, spec) => {
    const resolved = ts.resolveModuleName(
      spec,
      fromFile,
      options,
      ts.sys,
      cache,
    ).resolvedModule?.resolvedFileName;
    if (resolved === undefined) {
      return null;
    }
    if (fileSet.has(resolved)) {
      return resolved;
    }
    // A workspace symlink resolves through node_modules; the include
    // set knows the file by its target path.
    const real = ts.sys.realpath?.(resolved) ?? resolved;
    return fileSet.has(real) ? real : null;
  };
}

function collectAllGates(packs: ReadonlyArray<PatternPack>): string[] {
  const gates = new Set<string>();
  for (const pack of packs) {
    for (const g of collectPackGates(pack)) {
      gates.add(g);
    }
  }
  return [...gates];
}

function collectAllMarks(packs: ReadonlyArray<PatternPack>): string[] {
  const marks = new Set<string>();
  for (const pack of packs) {
    for (const mark of collectPackMarks(pack)) {
      marks.add(mark);
    }
  }
  return [...marks];
}

/** Bounded so a huge project does not exhaust the file-handle limit. */
const READ_CONCURRENCY = 32;

async function readImportsConcurrently(
  paths: ReadonlyArray<string>,
  marks: ReadonlyArray<string>,
): Promise<FileImports[]> {
  const results: FileImports[] = new Array(paths.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= paths.length) {
        return;
      }
      const p = paths[i];
      try {
        const text = await fs.readFile(p, "utf-8");
        const pre = ts.preProcessFile(text, true, false);
        results[i] = {
          path: p,
          importedModules: pre.importedFiles.map((f) => f.fileName),
          marked: marks.some((mark) => text.includes(mark)),
        };
      } catch {
        results[i] = { path: p, importedModules: [], marked: false };
      }
    }
  }
  const workers: Promise<void>[] = [];
  for (let i = 0; i < READ_CONCURRENCY; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}
