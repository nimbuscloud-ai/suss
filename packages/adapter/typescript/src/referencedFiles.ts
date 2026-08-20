/**
 * referencedFiles.ts: the project files a file references directly.
 *
 * The per-file cache invalidates a file's summaries when a file they
 * depend on changes. The file's own imports cover the types and
 * helpers it uses one hop away; reads that go further arrive through
 * recorded mechanisms (the resolution store's walks, the reachable
 * closure, unit claims), so the dependency set stays close to what a
 * walk can see rather than the whole import closure. A type chain
 * deeper than one hop past what those record is the stated gap.
 */

import type { SourceFile } from "ts-morph";

export interface ReferenceIndex {
  /** The directly referenced project files, one hop only. */
  directOf(filePath: string): ReadonlySet<string>;
}

/** Project files only: a package's change comes in through the key. */
export function createReferenceIndex(
  sourceFiles: ReadonlyArray<SourceFile>,
): ReferenceIndex {
  const direct = new Map<string, Set<string>>();
  for (const sourceFile of sourceFiles) {
    const referenced = new Set<string>();
    for (const target of sourceFile.getReferencedSourceFiles()) {
      if (target.isInNodeModules() || target.isDeclarationFile()) {
        continue;
      }
      referenced.add(target.getFilePath());
    }
    direct.set(sourceFile.getFilePath(), referenced);
  }

  const none: ReadonlySet<string> = new Set();
  return {
    directOf(filePath: string): ReadonlySet<string> {
      return direct.get(filePath) ?? none;
    },
  };
}
