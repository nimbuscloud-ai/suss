/**
 * The files each file in a run depends on, read from `importsFile`.
 *
 * No rule reads that relation. An adapter states it, and the run lists
 * each file's dependencies from it, which is what a cache invalidates a
 * summary by and what a checker rebuilds the module graph from.
 */

import type { Database } from "@suss/datalog";

/** Each importing file's imported files, both spelled by `displayPathOf`. */
export function importedFilesByFile(
  db: Database,
  displayPathOf: (file: string) => string,
): Map<string, string[]> {
  const byFile = new Map<string, string[]>();
  for (const [from, to] of db.facts("importsFile")) {
    if (typeof from !== "string" || typeof to !== "string") {
      continue;
    }
    const key = displayPathOf(from);
    const seen = byFile.get(key) ?? [];
    seen.push(displayPathOf(to));
    byFile.set(key, seen);
  }
  return byFile;
}
