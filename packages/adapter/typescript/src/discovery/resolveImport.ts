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

/**
 * Every way this file can write a reference to `importName` from
 * `importModule`.
 *
 * A named import gives the local identifier. A default or namespace
 * import of the same module gives a second spelling, because the
 * module object also exposes the named export as a property:
 * `import express from "express"` then `express.Router()` is the same
 * call as `import { Router } from "express"` then `Router()`.
 *
 * The root's own spelling is left out when it equals `importName`,
 * since a pack declaring the default export under the name people
 * give it (`express`) means the root and not a property of it.
 */
export function importedReferenceSpellings(
  sourceFile: SourceFile,
  importModule: string,
  importName: string,
): string[] {
  const spellings: string[] = [];
  const localName = resolveImportedLocalName(
    sourceFile,
    importModule,
    importName,
  );
  if (localName !== null) {
    spellings.push(localName);
  }
  // Callers walk every descendant once per spelling, so a file that
  // never writes the property is left with the spellings it had before.
  if (!sourceFile.getFullText().includes(`.${importName}`)) {
    return spellings;
  }
  for (const root of importedRootsOf(sourceFile, [importModule])) {
    if (root !== importName) {
      spellings.push(`${root}.${importName}`);
    }
  }
  return spellings;
}

export { resolveImportedLocalName as importedLocalNameOf };
