// source-file-lookup.ts — O(1) path → SourceFile map for the
// post-extraction passes (rethrow enrichment, reachable closure)
// that need to locate the function a summary describes by its
// `summary.location.file` path.
//
// `project.getSourceFiles()` walks the directory tree on every call;
// scanning that result per-summary turned the locate step into the
// dominant cost on monorepo-scale extracts (Twenty's NestJS backend
// at ~2,500 summaries was 88% of CPU in these passes). Building the
// lookup once and indexing by absolute path takes per-summary
// locate from O(N source files × tree walk) down to O(1 + one tree
// walk).
//
// `summary.location.file` is the source file's absolute path during
// extraction (the CLI rewrites it to a project-relative path AFTER
// `extractAll` returns). The map keys on the absolute path; a
// secondary suffix-index handles the rare case of a downstream pass
// that already saw a relative path.

import type { Project, SourceFile } from "ts-morph";

export interface SourceFileLookup {
  /** Direct lookup by absolute path. */
  byPath(absolutePath: string): SourceFile | null;
  /**
   * Suffix lookup, mirroring `sf.getFilePath().endsWith(rel)`.
   * Linear in the number of source files in the worst case but
   * each scan is over the cached list — no directory tree walk.
   */
  bySuffix(pathSuffix: string): SourceFile | null;
}

export function createSourceFileLookup(project: Project): SourceFileLookup {
  const all = project.getSourceFiles();
  const byAbs = new Map<string, SourceFile>();
  for (const sf of all) {
    byAbs.set(sf.getFilePath(), sf);
  }
  return {
    byPath(absolutePath: string): SourceFile | null {
      return byAbs.get(absolutePath) ?? null;
    },
    bySuffix(pathSuffix: string): SourceFile | null {
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
    },
  };
}
