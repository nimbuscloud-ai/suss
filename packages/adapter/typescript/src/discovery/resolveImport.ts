// resolveImport.ts: locate the local binding for a target import.
//
// Used by handlers that gate on a specific module + named export
// (resolverMap, graphqlImperativeCall) and need the local identifier
// the consumer actually wrote (which may be aliased).

import { importedRootsOf, namedImportsOf } from "./importScan.js";

import type { SourceFile } from "ts-morph";

/**
 * Locate local identifiers bound to the imported symbol (named,
 * default, or namespace import). Returns null when the consumer
 * doesn't import the target. The queried name matches the canonical
 * export or the alias, since callers hold whichever the config wrote.
 */
export function resolveImportedLocalName(
  sourceFile: SourceFile,
  importModule: string,
  importName: string,
): string | null {
  for (const one of namedImportsOf(sourceFile, [importModule])) {
    if (one.canonical === importName || one.local === importName) {
      return one.local;
    }
  }
  for (const root of importedRootsOf(sourceFile, [importModule])) {
    if (root === importName) {
      return root;
    }
  }
  return null;
}

export { resolveImportedLocalName as importedLocalNameOf };
