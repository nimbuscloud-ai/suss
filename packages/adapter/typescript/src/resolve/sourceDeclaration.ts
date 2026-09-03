/**
 * The source declaration behind a sibling workspace package's built
 * declaration.
 *
 * An import of a sibling package resolves through its manifest to a
 * built declaration file, and a declaration there has no body. The
 * manifest also says which source file each published file was built
 * from, so a declaration is looked up by export name on the published
 * file and taken from the source file instead. Discovery builds units
 * on the result, and the closure records it as where a call was
 * declared, so the call links to the summary a caller through the
 * package would reach.
 */

import path from "node:path";

import { sourceFileFor } from "../facts/store.js";
import {
  namedPackageDirAbove,
  resolvePackageExportsCached,
} from "../packageExports.js";

import type { Node } from "ts-morph";
import type { ResolutionStore } from "../facts/store.js";

/**
 * A declaration with no source behind it, such as one under
 * node_modules, comes back as it is. The source file can itself
 * re-export a third package, so the lookup repeats until it lands on
 * a source declaration; `visited` stops a cycle.
 */
export function sourceDeclarationsBehind(
  decl: Node,
  resolution: ResolutionStore,
  visited: Set<string> = new Set(),
): Node[] {
  const file = decl.getSourceFile();
  if (!file.isDeclarationFile() || file.isInNodeModules()) {
    return [decl];
  }
  const packageDir = namedPackageDirAbove(path.dirname(file.getFilePath()));
  if (packageDir === null || visited.has(packageDir)) {
    return [decl];
  }
  visited.add(packageDir);

  const project = file.getProject();
  const { entries } = resolvePackageExportsCached(
    path.join(packageDir, "package.json"),
  );
  const found: Node[] = [];
  for (const entry of entries) {
    const published = sourceFileFor(project, entry.publishedFile);
    const source = sourceFileFor(project, entry.sourceFile);
    if (published === undefined || source === undefined) {
      continue;
    }
    for (const [name, nodes] of resolution.exportsOf(published)) {
      if (!nodes.some((node) => sameDeclaration(node, decl))) {
        continue;
      }
      for (const behind of resolution.exportsOf(source).get(name) ?? []) {
        for (const candidate of sourceDeclarationsBehind(
          behind,
          resolution,
          visited,
        )) {
          if (!found.includes(candidate)) {
            found.push(candidate);
          }
        }
      }
    }
  }
  return found.length > 0 ? found : [decl];
}

function sameDeclaration(a: Node, b: Node): boolean {
  return (
    a === b ||
    (a.getSourceFile().getFilePath() === b.getSourceFile().getFilePath() &&
      a.getStart() === b.getStart() &&
      a.getEnd() === b.getEnd())
  );
}
