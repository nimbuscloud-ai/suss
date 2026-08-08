// lazyProjectInit.ts — bootstrap a ts-morph Project with only the
// files that any active pack's `requiresImport` gate matches.
//
// Default ts-morph behaviour parses every file in the tsconfig
// include glob at Project construction. On a monorepo that's
// thousands of files of parse work the extraction never touches —
// the closure pass only needs files that the discovered units
// reach, which is usually a small fraction of the project.
//
// This module:
//   1. Parses the tsconfig to get the include file list (no AST work)
//   2. Reads each file concurrently and runs `ts.preProcessFile`
//      (token-level scan, ~10× cheaper than a full parse)
//   3. Decides which files are candidates: any pack's gate matches
//      the file's imports
//   4. Adds only candidates to the Project
//
// Closure-time lazy loading: the closure pass uses
// `lazyAddSourceFile` to bring in non-candidate files when symbol
// resolution points there. The `projectFileSet` returned by this
// module lists files known to the tsconfig — we won't lazy-load
// node_modules content the user didn't ask about.

import fs from "node:fs/promises";
import path from "node:path";

import { Project, type SourceFile, ts } from "ts-morph";

import { namesAnyPackage } from "../facts/moduleGraph.js";
import { collectPackGates, packIsUngated } from "./preFilter.js";

import type { PatternPack } from "@suss/extractor";

// Re-export type so consumers don't need a separate import.
export type { Project } from "ts-morph";

export interface LazyProjectInit {
  project: Project;
  /** Candidates added at startup. */
  loadedFiles: SourceFile[];
  /**
   * Every file in the tsconfig include set, regardless of whether
   * it's loaded. The closure walk consults this to decide whether
   * a missing source file is "in the project but not loaded yet"
   * (eligible for lazy add) or "outside the project" (skip).
   */
  projectFileSet: ReadonlySet<string>;
}

/**
 * Build a Project that has only the gated files loaded. Returns
 * the loaded SourceFiles + the full project file set so the
 * closure pass can lazy-add the rest.
 */
export async function createLazyProject(
  tsConfigFilePath: string,
  packs: ReadonlyArray<PatternPack>,
): Promise<LazyProjectInit> {
  const allFiles = parseTsconfigFileList(tsConfigFilePath);
  const candidates = await selectCandidateFiles(allFiles, packs);

  const project = new Project({
    tsConfigFilePath,
    skipAddingFilesFromTsConfig: true,
  });
  const loadedFiles: SourceFile[] = [];
  for (const p of candidates) {
    const sf = project.addSourceFileAtPath(p);
    loadedFiles.push(sf);
  }

  return {
    project,
    loadedFiles,
    projectFileSet: new Set(allFiles),
  };
}

/**
 * Parse the tsconfig include set without constructing a Project
 * or reading any source files. Used by the cache layer to
 * compute the coarse key BEFORE the lazy bootstrap (cache hits
 * shouldn't pay for bootstrap).
 */
export function readTsconfigFileList(tsConfigFilePath: string): string[] {
  return parseTsconfigFileList(tsConfigFilePath);
}

/**
 * Add a file to an already-bootstrapped lazy Project. Used by the
 * closure pass when symbol resolution lands on a non-candidate
 * file that's still part of the tsconfig include set. Returns null
 * for paths outside the project file set (e.g. node_modules).
 *
 * Always calls `addSourceFileAtPath` even when `getSourceFile`
 * already returns a SourceFile. ts-morph's type checker can
 * surface a SourceFile via symbol resolution without putting it
 * in `project.getSourceFiles()`; downstream passes that enumerate
 * the project list (rethrow enrichment, partial-hit closure dedup)
 * miss those silently. addSourceFileAtPath is idempotent — a true
 * no-op when the file is genuinely already in the tracker.
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
 * Load everything a file imports, and everything those files import,
 * with each file loaded before the files that import it.
 *
 * The compiler discovers files by recursing: reading a file, resolving
 * its imports, and reading each of those the same way. Handed one file
 * at the top of a long chain of modules it recurses the whole chain in
 * one descent and the stack runs out, which is what a barrel chain a
 * few hundred deep does to a gated run, where the bootstrap loaded the
 * entry file alone. A file it has already read costs it nothing, so
 * loading the chain from the far end leaves it one hop of work per
 * file whatever the depth.
 *
 * The graph is read from the file text alone: a token scan for the
 * specifiers and the compiler's path resolution for each, neither of
 * which builds a program or parses a file. That keeps the walk here
 * iterative, and it is the same scan the gate pre-filter runs.
 *
 * Only files the project could already reach are loaded. A package
 * under node_modules is left to the resolution that asks for it.
 */
export function loadImportGraphDepthFirst(root: SourceFile): void {
  loadImportGraphsDepthFirst([root]);
}

/**
 * The same load for every file a run is about to walk, sharing one
 * visited set so each file is read once however many roots reach it.
 *
 * Running this once up front is what keeps the compiler's own walk
 * shallow for the whole run. Anything that touches the checker builds
 * the program, and discovery gets there long before anything asks a
 * module what it exports.
 *
 * Call it after the walked-file list is settled. It loads modules that
 * resolution would have loaded anyway, but a file that arrives before
 * the list is taken would be walked for units as well, which would
 * change what the run reports.
 */
export function loadImportGraphsDepthFirst(
  roots: ReadonlyArray<SourceFile>,
): DeepImportGraphs {
  const first = roots[0];
  if (first === undefined) {
    return { deepRoots: [] };
  }

  const project = first.getProject();
  const host = project.getModuleResolutionHost();
  const options = project.getCompilerOptions();

  const specifierPaths = (filePath: string): string[] => {
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
  };

  // Post-order over the import graph, so a file is loaded only after
  // everything it imports. The visited set is what ends a cycle, and
  // barrels that import each other are ordinary.
  const visited = new Set<string>();
  const loadOrder: string[] = [];
  const chainDepth = new Map<string, number>();
  for (const root of roots) {
    const rootPath = root.getFilePath();
    if (visited.has(rootPath)) {
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
        if (!visited.has(dep)) {
          visited.add(dep);
          stack.push({ path: dep, deps: specifierPaths(dep), next: 0 });
        }
        continue;
      }

      stack.pop();
      loadOrder.push(top.path);
      // Deps finished before this file did, so their depths are known.
      // A cycle leaves one of them unset, and treating that as zero is
      // right: going round again adds nothing to how deep the graph is.
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
      // A path the resolver named and the file system does not have.
      // Whatever asks for it next gets the same answer it gets today.
    }
  }

  // A run that had nothing to load already had the whole graph, and the
  // compiler saw those files in an order it could walk. Resolving them
  // again from the far end would only cost time.
  if (!loadedAnything) {
    return { deepRoots: [] };
  }

  const deepRoots = roots.filter(
    (root) => (chainDepth.get(root.getFilePath()) ?? 0) >= WARM_DEPTH,
  );
  return { deepRoots };
}

export interface DeepImportGraphs {
  /**
   * Roots whose import graph is deep enough that the checker cannot be
   * left to walk it by itself.
   */
  deepRoots: SourceFile[];
}

/**
 * How deep an import graph has to be before its aliases are resolved
 * from the far end rather than left to the checker.
 *
 * Warming changes the order things resolve in, never what they resolve
 * to, so this decides where to spend the time and not what the answer
 * is. Well under the depth the checker handles on its own, and far
 * above what an ordinary barrel reaches.
 */
const WARM_DEPTH = 100;

/** A file's text, from the parse the project already has or from disk. */
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

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function parseTsconfigFileList(tsConfigFilePath: string): string[] {
  const configFile = ts.readConfigFile(tsConfigFilePath, ts.sys.readFile);
  if (configFile.error !== undefined) {
    return [];
  }
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(tsConfigFilePath),
    /*existingOptions*/ undefined,
    tsConfigFilePath,
  );
  return parsed.fileNames;
}

interface FileImports {
  path: string;
  importedModules: string[];
}

async function selectCandidateFiles(
  allFiles: ReadonlyArray<string>,
  packs: ReadonlyArray<PatternPack>,
): Promise<string[]> {
  // Bucket packs into ungated (apply to every file) + gated.
  const ungatedExists = packs.some(packIsUngated);
  if (ungatedExists) {
    // At least one pack matches every file — no point pre-filtering.
    // Return the full set; per-file pre-filter handles per-pack
    // applicability later.
    return [...allFiles];
  }
  const gates = collectAllGates(packs);
  if (gates.length === 0) {
    return [];
  }

  // Concurrent read + preProcessFile across the include set.
  // Bounded concurrency keeps OS file-handle limits sane on huge
  // projects.
  const fileImports = await readImportsConcurrently(allFiles);
  const matched: string[] = [];
  for (const { path: p, importedModules } of fileImports) {
    if (namesAnyPackage(importedModules, gates)) {
      matched.push(p);
    }
  }
  return matched;
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

const READ_CONCURRENCY = 32;

async function readImportsConcurrently(
  paths: ReadonlyArray<string>,
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
        };
      } catch {
        results[i] = { path: p, importedModules: [] };
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
