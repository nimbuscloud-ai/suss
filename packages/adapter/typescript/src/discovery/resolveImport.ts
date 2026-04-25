// resolveImport.ts — locate the local binding for a target import.
//
// Used by handlers that gate on a specific module + named export
// (resolverMap, graphqlImperativeCall) and need the local identifier
// the consumer actually wrote (which may be aliased).

import type { SourceFile } from "ts-morph";

/**
 * Locate local identifiers that hold the imported symbol (named,
 * default, or namespace import). Returns null when the consumer
 * doesn't import the target.
 */
export function resolveImportedLocalName(
  sourceFile: SourceFile,
  importModule: string,
  importName: string,
): string | null {
  for (const importDecl of sourceFile.getImportDeclarations()) {
    if (importDecl.getModuleSpecifierValue() !== importModule) {
      continue;
    }
    for (const named of importDecl.getNamedImports()) {
      if (
        named.getName() === importName ||
        named.getAliasNode()?.getText() === importName
      ) {
        return named.getAliasNode()?.getText() ?? named.getName();
      }
    }
    const defaultImport = importDecl.getDefaultImport();
    if (defaultImport !== undefined && defaultImport.getText() === importName) {
      return defaultImport.getText();
    }
    const namespaceImport = importDecl.getNamespaceImport();
    if (
      namespaceImport !== undefined &&
      namespaceImport.getText() === importName
    ) {
      return namespaceImport.getText();
    }
  }
  return null;
}
