import { createPerFileCache } from "./perFileCache.js";

import type { SourceFile } from "ts-morph";

type ExportedDeclarationMap = ReturnType<SourceFile["getExportedDeclarations"]>;

/**
 * What a module exports, by exported name.
 *
 * ts-morph rebuilds this map from scratch on every `getExportedDeclarations`
 * call, walking the file's export symbols and following each alias through
 * the type checker. Callee resolution asks the same file the same question
 * once per import site, so the answer is kept for as long as the parse it
 * was read out of.
 */
export function exportedDeclarationsOf(
  sourceFile: SourceFile,
): ExportedDeclarationMap {
  const cached = exportsByFile.get(sourceFile);
  if (cached !== undefined) {
    return cached;
  }
  const declarations = sourceFile.getExportedDeclarations();
  exportsByFile.set(sourceFile, declarations);
  return declarations;
}

const exportsByFile = createPerFileCache<ExportedDeclarationMap>();
