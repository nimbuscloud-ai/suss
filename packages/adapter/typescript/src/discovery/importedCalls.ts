/**
 * The calls in one file whose callee resolves to a module's export,
 * asked of the store in one batch. This replaces the per-handler
 * import readers, which matched the local name an import bound and
 * stopped there: the store follows aliases and project re-export
 * barrels to the same answer.
 */

import { Node, type SourceFile } from "ts-morph";

import type { CallExpression, NewExpression } from "ts-morph";
import type { ResolutionStore } from "../facts/store.js";

export interface ImportedCallSpec {
  module: string;
  name: string;
}

/**
 * Every call or construction whose callee comes from `spec.module`'s
 * export `spec.name`. A callee declared as a local function or class
 * in this project is never the import, so it is not asked about.
 */
export function callsResolvingTo(
  sourceFile: SourceFile,
  resolution: ResolutionStore,
  spec: ImportedCallSpec,
): Array<CallExpression | NewExpression> {
  const candidates: Array<CallExpression | NewExpression> = [];
  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node) && !Node.isNewExpression(node)) {
      return;
    }
    const callee = node.getExpression();
    if (Node.isIdentifier(callee) && !declaredLocally(callee)) {
      candidates.push(node);
    }
  });
  if (candidates.length === 0) {
    return [];
  }

  const origins = resolution.importOriginsOfMany(
    candidates.map((call) => call.getExpression()),
    [spec.module],
  );
  return candidates.filter((call) =>
    (origins.get(call.getExpression()) ?? []).some(
      (origin) => origin.path.length === 1 && origin.path[0] === spec.name,
    ),
  );
}

/** Whether every declaration behind a name is this project's own function or class. */
function declaredLocally(callee: Node): boolean {
  const declarations = callee.getSymbol()?.getDeclarations() ?? [];
  return (
    declarations.length > 0 &&
    declarations.every(
      (declaration) =>
        (Node.isFunctionDeclaration(declaration) ||
          Node.isClassDeclaration(declaration)) &&
        !declaration.getSourceFile().isInNodeModules(),
    )
  );
}
