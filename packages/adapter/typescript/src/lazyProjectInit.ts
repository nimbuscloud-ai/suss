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
 */
export function lazyAddSourceFile(
  project: Project,
  projectFileSet: ReadonlySet<string>,
  filePath: string,
): SourceFile | null {
  if (!projectFileSet.has(filePath)) {
    return null;
  }
  const existing = project.getSourceFile(filePath);
  if (existing !== undefined) {
    return existing;
  }
  try {
    return project.addSourceFileAtPath(filePath);
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
    if (anyImportMatchesGate(importedModules, gates)) {
      matched.push(p);
    }
  }
  return matched;
}

function packIsUngated(pack: PatternPack): boolean {
  for (const pattern of pack.discovery) {
    const requires = pattern.requiresImport;
    if (requires === undefined || requires.length === 0) {
      return true;
    }
  }
  return false;
}

function collectAllGates(packs: ReadonlyArray<PatternPack>): string[] {
  const gates = new Set<string>();
  for (const pack of packs) {
    for (const pattern of pack.discovery) {
      const requires = pattern.requiresImport;
      if (requires === undefined) {
        continue;
      }
      for (const g of requires) {
        gates.add(g);
      }
    }
  }
  return [...gates];
}

function anyImportMatchesGate(
  importedModules: ReadonlyArray<string>,
  gates: ReadonlyArray<string>,
): boolean {
  for (const mod of importedModules) {
    for (const gate of gates) {
      if (mod === gate || mod.startsWith(`${gate}/`)) {
        return true;
      }
    }
  }
  return false;
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
