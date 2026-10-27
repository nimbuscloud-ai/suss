/**
 * The calls in one file whose callee resolves to a module's export,
 * asked of the store in one batch. This replaces the per-handler
 * import readers, which matched the local name an import bound and
 * stopped there: the store follows aliases and project re-export
 * barrels to the same answer.
 */

import { Node, type SourceFile, ts } from "ts-morph";

import { forEachDescendantWhere } from "../walk/rawDescent.js";

import type {
  CallExpression,
  ImportDeclaration,
  NewExpression,
} from "ts-morph";
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
  return callsNamed(importedCallOrigins(sourceFile, resolution, module), names);
}

/** A file's calls of names it did not declare, with what each callee is in one module. */
export interface ImportedCallOrigins {
  candidates: Array<CallExpression | NewExpression>;
  origins: Map<Node, Array<{ module: string; path: string[] }>>;
}

/**
 * The store's answer for every call `callsByOriginName` asks about, so a
 * caller matching several names from one module asks once.
 */
export function importedCallOrigins(
  sourceFile: SourceFile,
  resolution: ResolutionStore,
  module: string,
): ImportedCallOrigins {
  const candidates: Array<CallExpression | NewExpression> = [];
  forEachDescendantWhere(sourceFile, callsANamedCallee, (node) => {
    const call = node as CallExpression | NewExpression;
    const callee = call.getExpression();
    if (
      !declaredLocally(callee) &&
      !importedFromAnotherPackage(callee, module)
    ) {
      candidates.push(call);
    }
    return false;
  });
  if (candidates.length === 0) {
    return { candidates, origins: new Map() };
  }

  const origins = resolution.importOriginsOfMany(
    candidates.map((call) => call.getExpression()),
    [module],
  );
  return { candidates, origins };
}

/** The calls among `found` whose callee is one of `names`, each with the name it is. */
export function callsNamed(
  found: ImportedCallOrigins,
  names: ReadonlySet<string>,
): Map<CallExpression | NewExpression, string> {
  const matched = new Map<CallExpression | NewExpression, string>();
  for (const call of found.candidates) {
    const origin = (found.origins.get(call.getExpression()) ?? []).find(
      (one) => one.path.length === 1 && names.has(one.path[0] ?? ""),
    );
    const name = origin?.path[0];
    if (name !== undefined) {
      matched.set(call, name);
    }
  }
  return matched;
}

/** A call or a construction whose callee is a bare name. */
function callsANamedCallee(raw: ts.Node): boolean {
  return (
    (ts.isCallExpression(raw) || ts.isNewExpression(raw)) &&
    ts.isIdentifier(raw.expression)
  );
}

/** Whether `specifier` is `module`, a path inside it, or a package `module` is inside. */
const samePackage = (specifier: string, module: string): boolean =>
  specifier === module ||
  specifier.startsWith(`${module}/`) ||
  module.startsWith(`${specifier}/`);

/** The import a named or default import binding comes from. */
function importOf(declaration: Node): ImportDeclaration | undefined {
  if (Node.isImportSpecifier(declaration)) {
    return declaration.getImportDeclaration();
  }
  const parent = Node.isImportClause(declaration)
    ? declaration.getParent()
    : undefined;
  return parent !== undefined && Node.isImportDeclaration(parent)
    ? parent
    : undefined;
}

/**
 * Whether every declaration behind a name is an import from a package
 * other than `module`. The store reads a package only as far as its
 * name, so a name imported from one never comes out as another's export.
 * An import that resolves to a project file can re-export anything.
 */
function importedFromAnotherPackage(callee: Node, module: string): boolean {
  const declarations = callee.getSymbol()?.getDeclarations() ?? [];
  return (
    declarations.length > 0 &&
    declarations.every((declaration) => {
      const from = importOf(declaration);
      if (from === undefined) {
        return false;
      }
      const resolved = from.getModuleSpecifierSourceFile();
      const specifier = from.getModuleSpecifierValue();
      return (
        (resolved === undefined || resolved.isInNodeModules()) &&
        !specifier.startsWith(".") &&
        !samePackage(specifier, module)
      );
    })
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
