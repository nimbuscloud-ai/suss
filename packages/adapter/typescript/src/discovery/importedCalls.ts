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
  return [
    ...callsByOriginName(
      sourceFile,
      resolution,
      spec.module,
      new Set([spec.name]),
    ).keys(),
  ];
}

/**
 * The calls whose callee comes from one of `names` exported by
 * `module`, each mapped to the export it resolves to. One batched ask
 * per file, however many names a pack matches.
 */
export function callsByOriginName(
  sourceFile: SourceFile,
  resolution: ResolutionStore,
  module: string,
  names: ReadonlySet<string>,
): Map<CallExpression | NewExpression, string> {
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

  const matched = new Map<CallExpression | NewExpression, string>();
  if (candidates.length === 0) {
    return matched;
  }

  const origins = resolution.importOriginsOfMany(
    candidates.map((call) => call.getExpression()),
    [module],
  );
  for (const call of candidates) {
    const origin = (origins.get(call.getExpression()) ?? []).find(
      (one) => one.path.length === 1 && names.has(one.path[0] ?? ""),
    );
    const name = origin?.path[0];
    if (name !== undefined) {
      matched.set(call, name);
    }
  }
  return matched;
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
