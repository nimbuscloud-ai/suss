// namedExport.ts — discover code units exposed via specific named
// (or default) exports. The bread-and-butter discovery for frameworks
// that key off naming conventions (`loader`, `action` in React Router,
// `handler` in serverless toolchains, etc.).

import {
  type ArrowFunction,
  type FunctionDeclaration,
  type FunctionExpression,
  Node,
  type SourceFile,
} from "ts-morph";

import { type DiscoveredUnit, toFunctionRoot } from "./shared.js";

import type { DiscoveryPattern } from "@suss/extractor";
import type { FunctionRoot } from "../conditions.js";

/**
 * Name a code unit discovered via `export default`. Prefers the
 * function's own identifier (`export default function UserCard() {}`
 * → `"UserCard"`) so component / handler identity survives. Falls
 * back to `"default"` for genuinely anonymous defaults
 * (`export default () => ...` or `export default function() {}`).
 */
function resolveDefaultExportName(decl: Node, fn: FunctionRoot): string {
  // FunctionDeclaration and named FunctionExpression both expose
  // getName(); ArrowFunction does not. Prefer the explicit name when
  // present.
  if (Node.isFunctionDeclaration(fn) || Node.isFunctionExpression(fn)) {
    const n = fn.getName?.();
    if (typeof n === "string" && n.length > 0) {
      return n;
    }
  }

  // `export default UserCard` — the declaration seen by the default-
  // export symbol resolver is the VariableDeclaration or the
  // referenced function. If we landed on a named VariableDeclaration,
  // use that name.
  if (Node.isVariableDeclaration(decl)) {
    const name = decl.getName();
    if (name.length > 0) {
      return name;
    }
  }

  return "default";
}

export function discoverNamedExports(
  sourceFile: SourceFile,
  match: Extract<DiscoveryPattern["match"], { type: "namedExport" }>,
  kind: string,
): DiscoveredUnit[] {
  const results: DiscoveredUnit[] = [];
  const names = new Set(match.names);

  // 1. export function loader() {}
  for (const fn of sourceFile.getFunctions()) {
    if (!fn.isExported()) {
      continue;
    }
    const name = fn.getName();
    if (name === undefined) {
      continue;
    }
    if (!names.has(name)) {
      continue;
    }
    results.push({ func: fn as FunctionDeclaration, kind, name });
  }

  // 2. export const loader = () => {} / export const loader = function() {}
  for (const varDecl of sourceFile.getVariableDeclarations()) {
    const name = varDecl.getName();
    if (!names.has(name)) {
      continue;
    }

    // Check if the variable statement is exported
    const varStatement = varDecl.getVariableStatement();
    if (varStatement === undefined) {
      continue;
    }
    if (!varStatement.isExported()) {
      continue;
    }

    const init = varDecl.getInitializer();
    if (init === undefined) {
      continue;
    }

    if (Node.isArrowFunction(init) || Node.isFunctionExpression(init)) {
      results.push({
        func: init as ArrowFunction | FunctionExpression,
        kind,
        name,
      });
    }
  }

  // 3. export default function UserCard() {} — name "UserCard"
  //    export default function() {}          — name "default"
  //    export default UserCard               — name from the referenced binding
  //    export default () => ...              — name "default"
  //
  // Prefer the function's own name when it has one. For components
  // especially, the function name is the component identity; losing
  // it to "default" would collapse every file's default export into
  // the same name across the workspace.
  if (names.has("default")) {
    const defaultExport = sourceFile.getDefaultExportSymbol();
    if (defaultExport !== undefined) {
      const decls = defaultExport.getDeclarations();
      for (const decl of decls) {
        const fn = toFunctionRoot(decl);
        if (fn !== null) {
          const resolvedName = resolveDefaultExportName(decl, fn);
          results.push({ func: fn, kind, name: resolvedName });
        }
      }
    }
  }

  // 4. export { loader } re-export or any other form
  // Use getExportedDeclarations for names we haven't already found
  const alreadyFound = new Set(results.map((r) => r.name));
  for (const targetName of names) {
    if (alreadyFound.has(targetName)) {
      continue;
    }

    const exported = sourceFile.getExportedDeclarations().get(targetName);
    if (exported === undefined) {
      continue;
    }

    for (const decl of exported) {
      const fn = toFunctionRoot(decl);
      if (fn !== null) {
        results.push({ func: fn, kind, name: targetName });
        break;
      }
    }
  }

  return results;
}
