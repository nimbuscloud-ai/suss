/**
 * moduleImports.ts: writing `metadata.moduleImports` on a summary set.
 *
 * Every adapter records the project files a summary's own file depends
 * on, and a checker rebuilds the module graph from that field to find
 * what runs inside a deployable unit. The adapters differ in where the
 * edges come from (TypeScript resolves import declarations, Python
 * resolves them through facts, Ruby has `require_relative` and constant
 * references), so the stamp takes a lookup and leaves the source to them.
 *
 * The paths a lookup returns must be spelled the way `location.file` is,
 * so both ends of the graph match. An empty list is stamped as one, which
 * makes the file a leaf of the graph; undefined leaves the summary alone.
 */

import type { BehavioralSummary } from "@suss/behavioral-ir";

export function stampModuleImports(
  summaries: BehavioralSummary[],
  importsOf: (file: string) => Iterable<string> | undefined,
): void {
  const byFile = new Map<string, string[] | undefined>();
  for (const summary of summaries) {
    const file = summary.location.file;
    if (!byFile.has(file)) {
      const found = importsOf(file);
      byFile.set(
        file,
        found === undefined ? undefined : [...new Set(found)].sort(),
      );
    }

    const imports = byFile.get(file);
    if (imports === undefined) {
      continue;
    }
    summary.metadata = {
      ...(summary.metadata ?? {}),
      moduleImports: imports,
    };
  }
}
