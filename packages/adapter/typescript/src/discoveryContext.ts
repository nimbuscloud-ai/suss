// discoveryContext.ts — Primitives the TypeScript adapter exposes to
// packs whose `discoverUnits` callback walks a source file looking
// for top-level units that don't fit one of the data-driven
// `DiscoveryMatch` variants.
//
// Sibling of `subUnitContext.ts` for the discovery layer. Packs that
// use this hook (e.g. React's component-export heuristic) cast the
// `ctx: unknown` argument to `TsDiscoveryContext` — same "I expect the
// TypeScript adapter" contract `subUnits` follows.
//
// Helpers stay narrow on purpose. They cover the cases real packs need
// without exposing arbitrary ts-morph surface to pack authors.

import { Node, type SourceFile } from "ts-morph";

import type { FunctionRoot } from "./conditions.js";

export interface TsDiscoveryContext {
  /** Full filesystem path of the source file. Useful for excluding
   *  test / story files via the pack's own regex. */
  getFilePath(sourceFile: SourceFile): string;

  /**
   * Yield every export from the source file whose declaration is a
   * function — function declarations, arrow / function-expression
   * variable initializers, and re-exports of either. Skips
   * non-function exports (constants, classes, types).
   *
   * Each entry carries the exported name (the binding the consumer
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
   * — nested arrow returning JSX is its own component, not part of
   * this function's output.
   *
   * Concise-arrow bodies (`() => <X/>`) are handled — the body IS
   * the implicit return.
   */
  hasJsxReturn(func: FunctionRoot): boolean;
}

export function createTsDiscoveryContext(): TsDiscoveryContext {
  return {
    getFilePath,
    exportedFunctions,
    hasJsxReturn,
  };
}

function getFilePath(sourceFile: SourceFile): string {
  return sourceFile.getFilePath();
}

function exportedFunctions(
  sourceFile: SourceFile,
): Array<{ name: string; func: FunctionRoot; isDefault: boolean }> {
  const out: Array<{ name: string; func: FunctionRoot; isDefault: boolean }> =
    [];
  const seen = new Set<string>();

  for (const [name, declarations] of sourceFile.getExportedDeclarations()) {
    if (seen.has(name)) {
      continue;
    }
    for (const decl of declarations) {
      const fn = resolveDeclarationToFunction(decl);
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

function resolveDeclarationToFunction(decl: Node): FunctionRoot | null {
  if (
    Node.isFunctionDeclaration(decl) ||
    Node.isFunctionExpression(decl) ||
    Node.isArrowFunction(decl) ||
    Node.isMethodDeclaration(decl)
  ) {
    return decl as FunctionRoot;
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
  let current = node;
  while (Node.isParenthesizedExpression(current)) {
    current = current.getExpression();
  }
  return (
    Node.isJsxElement(current) ||
    Node.isJsxSelfClosingElement(current) ||
    Node.isJsxFragment(current)
  );
}
