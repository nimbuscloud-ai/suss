// discoveryContext.ts: Primitives the TypeScript adapter exposes to
// packs whose `discoverUnits` callback walks a source file looking
// for top-level units that don't fit one of the data-driven
// `DiscoveryMatch` variants.
//
// Sibling of `subUnitContext.ts` for the discovery layer. Packs that
// use this hook (e.g. React's component-export heuristic) cast the
// `ctx: unknown` argument to `TsDiscoveryContext`: same "I expect the
// TypeScript adapter" contract `subUnits` follows.
//
// Helpers stay narrow on purpose. They cover the cases real packs need
// without exposing arbitrary ts-morph surface to pack authors.

import { Node, type SourceFile } from "ts-morph";

import { couldStillNameAFunction, toFunctionRoot } from "./discovery/shared.js";
import { isWrittenAgain } from "./facts/assignments.js";
import { ResolutionStore } from "./facts/store.js";
import { exportedDeclarationsOf } from "./moduleExports.js";
import { peelParens } from "./walk/unwrap.js";

import type { FunctionRoot } from "./conditions.js";

export interface TsDiscoveryContext {
  /** Full filesystem path of the source file. Useful for excluding
   *  test / story files via the pack's own regex. */
  getFilePath(sourceFile: SourceFile): string;

  /**
   * Yield every export from the source file whose declaration is a
   * function: function declarations, arrow / function-expression
   * variable initializers, and re-exports of either. Skips
   * non-function exports (constants, classes, types).
   *
   * Each entry has the exported name (the binding the consumer
   * uses), the function root, and whether the export is the file's
   * default export. `default` is included; the pack decides whether
   * to handle it (typically the data-driven `namedExport(["default"])`
   * already does, and the callback skips to avoid duplicates).
   */
  exportedFunctions(
    sourceFile: SourceFile,
  ): Array<{ name: string; func: FunctionRoot; isDefault: boolean }>;

  /**
   * Walk a function's body for return statements whose value is a
   * JSX element / fragment / self-closing tag. Returns true on the
   * first match; false otherwise. Skips into nested function bodies
   *: nested arrow returning JSX is its own component, not part of
   * this function's output.
   *
   * Concise-arrow bodies (`() => <X/>`) are handled: the body IS
   * the implicit return.
   */
  hasJsxReturn(func: FunctionRoot): boolean;
}

export function createTsDiscoveryContext(
  resolution?: ResolutionStore,
): TsDiscoveryContext {
  // The adapter passes its run's store; a bare call gets its own.
  const store = resolution ?? new ResolutionStore();
  return {
    getFilePath,
    exportedFunctions: (sourceFile) => exportedFunctions(sourceFile, store),
    hasJsxReturn,
  };
}

function getFilePath(sourceFile: SourceFile): string {
  return sourceFile.getFilePath();
}

function exportedFunctions(
  sourceFile: SourceFile,
  resolution: ResolutionStore,
): Array<{ name: string; func: FunctionRoot; isDefault: boolean }> {
  const out: Array<{ name: string; func: FunctionRoot; isDefault: boolean }> =
    [];
  const seen = new Set<string>();

  for (const [name, declarations] of exportedDeclarationsOf(
    sourceFile,
    resolution,
  )) {
    if (seen.has(name)) {
      continue;
    }
    for (const decl of declarations) {
      const fn = exportedFunction(decl, resolution);
      if (fn === null) {
        continue;
      }
      out.push({ name, func: fn, isDefault: name === "default" });
      seen.add(name);
      break;
    }
  }
  return out;
}

/**
 * The function behind an export, however the export was written.
 *
 * A name written once is read straight off the syntax at the
 * declaration, which covers most exports and costs nothing. A name
 * written more than once has a different value by the time anything
 * imports it, so the binding goes to the fact layer and the rules decide
 * which write survives. When they cannot decide, this returns nothing
 * rather than the first value it saw.
 */
function exportedFunction(
  decl: Node,
  resolution?: ResolutionStore,
): FunctionRoot | null {
  const writtenAgain = Node.isVariableDeclaration(decl) && isWrittenAgain(decl);
  if (!writtenAgain) {
    const declared = resolveDeclarationToFunction(decl);
    if (declared !== null) {
      return declared;
    }
  }
  if (resolution === undefined) {
    return null;
  }

  // The export is a wrapper call, an alias or a `.bind` rather than a
  // function. The fact layer follows those to the function underneath.
  const value = valueToAskAbout(decl, writtenAgain);
  if (value === null) {
    return null;
  }
  const resolved = resolution.resolveCallable(value);
  return resolved === null ? null : toFunctionRoot(resolved);
}

function valueToAskAbout(decl: Node, writtenAgain: boolean): Node | null {
  if (writtenAgain) {
    return decl;
  }
  const value = Node.isVariableDeclaration(decl)
    ? (decl.getInitializer() ?? decl)
    : decl;
  return couldStillNameAFunction(value) ? value : null;
}

function resolveDeclarationToFunction(decl: Node): FunctionRoot | null {
  const fn = toFunctionRoot(decl);
  if (fn !== null) {
    return fn;
  }
  if (Node.isVariableDeclaration(decl)) {
    const init = decl.getInitializer();
    if (
      init !== undefined &&
      (Node.isArrowFunction(init) || Node.isFunctionExpression(init))
    ) {
      return init as FunctionRoot;
    }
  }
  return null;
}

function hasJsxReturn(func: FunctionRoot): boolean {
  if (Node.isArrowFunction(func)) {
    const body = func.getBody();
    if (Node.isExpression(body) && isJsxOrFragment(body)) {
      return true;
    }
  }

  const body = func.getBody?.();
  if (body === undefined) {
    return false;
  }

  let found = false;
  body.forEachDescendant((node, traversal) => {
    if (found) {
      traversal.stop();
      return;
    }
    // Deliberately stricter than isDescentStop: a JSX return inside a
    // nested arrow (a render prop, a map callback) is that function's
    // output, and descending would make its parent read as a
    // component.
    if (
      node !== func &&
      (Node.isFunctionDeclaration(node) ||
        Node.isFunctionExpression(node) ||
        Node.isArrowFunction(node) ||
        Node.isMethodDeclaration(node))
    ) {
      traversal.skip();
      return;
    }
    if (Node.isReturnStatement(node)) {
      const expr = node.getExpression();
      if (expr !== undefined && isJsxOrFragment(expr)) {
        found = true;
      }
    }
  });
  return found;
}

function isJsxOrFragment(node: Node): boolean {
  const current = peelParens(node);
  return (
    Node.isJsxElement(current) ||
    Node.isJsxSelfClosingElement(current) ||
    Node.isJsxFragment(current)
  );
}
