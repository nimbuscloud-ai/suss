// sourceFileLookup.ts: O(1) path → SourceFile map for the
// post-extraction passes (rethrow enrichment, reachable closure,
// wrapper expansion, sub-unit synthesis) that need to locate the
// function a summary describes by its `summary.location` path and
// line range.
//
// `project.getSourceFiles()` walks the directory tree on every call;
// scanning that result per-summary turned the locate step into the
// dominant cost on monorepo-scale extracts. Building the lookup
// once and indexing by absolute path takes per-summary locate from
// O(N source files × tree walk) down to O(1 + one tree walk).
//
// The same argument applies inside a file. Several summaries usually
// describe functions in one source file, so `functionAt` indexes a
// file's functions by line range the first time it is asked, and reads
// the rest out of that index.
//
// `summary.location.file` is the source file's absolute path during
// extraction (the CLI rewrites it to a project-relative path AFTER
// `extractAll` returns). The map keys on the absolute path; a
// secondary suffix-index handles the rare case of a downstream pass
// that already saw a relative path.

import { Node } from "ts-morph";

import { endLineOf, startLineOf } from "../lines.js";

import type { Project, SourceFile } from "ts-morph";
import type { FunctionRoot } from "../conditions.js";

export interface SummaryLocation {
  file: string;
  range: { start: number; end: number };
  /** Character offsets, which the index prefers: lines can collide. */
  span?: { start: number; end: number } | undefined;
}

export interface SourceFileLookup {
  /** Direct lookup by absolute path. */
  byPath(absolutePath: string): SourceFile | null;
  /**
   * Suffix lookup, mirroring `sf.getFilePath().endsWith(rel)`.
   * Linear in the number of source files in the worst case but
   * each scan is over the cached list: no directory tree walk.
   */
  bySuffix(pathSuffix: string): SourceFile | null;
  /**
   * The function occupying a summary's line range, in the file that
   * summary names. When two functions share a range the outermost
   * one wins, which is what a document-order scan used to return.
   */
  functionAt(location: SummaryLocation): FunctionRoot | null;
}

export function createSourceFileLookup(project: Project): SourceFileLookup {
  const all = project.getSourceFiles();
  const byAbs = new Map<string, SourceFile>();
  for (const sf of all) {
    byAbs.set(sf.getFilePath(), sf);
  }
  const bySuffixResult = new Map<string, SourceFile | null>();
  const functionsByFile = new Map<string, Map<string, FunctionRoot>>();

  function bySuffix(pathSuffix: string): SourceFile | null {
    const memo = bySuffixResult.get(pathSuffix);
    if (memo !== undefined) {
      return memo;
    }
    const answer = scanForSuffix(all, byAbs, pathSuffix);
    bySuffixResult.set(pathSuffix, answer);
    return answer;
  }

  return {
    byPath(absolutePath: string): SourceFile | null {
      return byAbs.get(absolutePath) ?? null;
    },
    bySuffix,
    functionAt(location: SummaryLocation): FunctionRoot | null {
      const sf = bySuffix(location.file);
      if (sf === null) {
        return null;
      }
      const path = sf.getFilePath();
      const index = functionsByFile.get(path) ?? indexFunctions(sf);
      functionsByFile.set(path, index);
      if (location.span !== undefined) {
        const bySpan = index.get(spanKey(location.span));
        if (bySpan !== undefined) {
          return bySpan;
        }
      }
      return index.get(rangeKey(location.range)) ?? null;
    },
  };
}

function scanForSuffix(
  all: SourceFile[],
  byAbs: Map<string, SourceFile>,
  pathSuffix: string,
): SourceFile | null {
  const direct = byAbs.get(pathSuffix);
  if (direct !== undefined) {
    return direct;
  }
  for (const sf of all) {
    if (sf.getFilePath().endsWith(pathSuffix)) {
      return sf;
    }
  }
  return null;
}

function rangeKey(range: { start: number; end: number }): string {
  return `lines ${range.start}:${range.end}`;
}

function spanKey(span: { start: number; end: number }): string {
  return `span ${span.start}:${span.end}`;
}

function indexFunctions(sf: SourceFile): Map<string, FunctionRoot> {
  const index = new Map<string, FunctionRoot>();
  sf.forEachDescendant((node) => {
    if (
      !Node.isFunctionDeclaration(node) &&
      !Node.isFunctionExpression(node) &&
      !Node.isArrowFunction(node) &&
      !Node.isMethodDeclaration(node)
    ) {
      return;
    }
    const bySpan = spanKey({ start: node.getStart(), end: node.getEnd() });
    index.set(bySpan, node);
    const key = rangeKey({ start: startLineOf(node), end: endLineOf(node) });
    if (!index.has(key)) {
      index.set(key, node);
    }
  });
  return index;
}
