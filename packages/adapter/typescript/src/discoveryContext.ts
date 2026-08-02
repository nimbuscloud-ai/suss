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

import { Node, type ObjectLiteralExpression, type SourceFile } from "ts-morph";

import { couldStillNameAFunction, toFunctionRoot } from "./discovery/shared.js";
import { isWrittenAgain } from "./facts/assignments.js";
import { exportedDeclarationsOf } from "./moduleExports.js";

import type { FunctionRoot } from "./conditions.js";
import type { ResolutionStore } from "./facts/store.js";

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
   * For an export the project builds by calling a factory, the string a
   * property of that call's config object holds:
   * `export const handler = makeWidgetHandler({ subject: "a.b" }, ...)`
   * with `{ property: "subject" }` answers `"a.b"`.
   *
   * Which function was called and which argument carried the config are
   * questions the caller does not have to answer. Every object argument
   * is read. Naming the callee or fixing the argument position narrows
   * that, for a project whose factories would otherwise collide.
   *
   * Two arguments holding the property under different values answers
   * null, since nothing says which one was meant.
   *
   * The config argument is usually an object literal at the call site;
   * a variable or import is followed to the literal it resolves to.
   * `as const` and parentheses around the property value are peeled.
   * Anything but a string literal underneath (a computed subject, a
   * template, a call) answers null — the caller attaches nothing
   * rather than guessing.
   */
  exportedCallConfigString(
    sourceFile: SourceFile,
    exportName: string,
    spec: { callees?: string[]; argIndex?: number; property: string },
  ): string | null;

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

export function createTsDiscoveryContext(
  resolution?: ResolutionStore,
): TsDiscoveryContext {
  return {
    getFilePath,
    exportedFunctions: (sourceFile) =>
      exportedFunctions(sourceFile, resolution),
    exportedCallConfigString: (sourceFile, exportName, spec) =>
      exportedCallConfigString(sourceFile, exportName, spec, resolution),
    hasJsxReturn,
  };
}

function getFilePath(sourceFile: SourceFile): string {
  return sourceFile.getFilePath();
}

function exportedFunctions(
  sourceFile: SourceFile,
  resolution?: ResolutionStore,
): Array<{ name: string; func: FunctionRoot; isDefault: boolean }> {
  const out: Array<{ name: string; func: FunctionRoot; isDefault: boolean }> =
    [];
  const seen = new Set<string>();

  for (const [name, declarations] of exportedDeclarationsOf(sourceFile)) {
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
 * The function an export is, however it got there.
 *
 * A name written once is answered from the syntax at the declaration,
 * which is what most exports are and costs nothing. A name written
 * again holds a different value by the time anything imports it, so
 * the binding goes to the fact layer and the rules say which write
 * survives. When they cannot say, the export has no function here,
 * which is the answer rather than the first value.
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

  // The export is a wrapper call, an alias, or a .bind rather than a
  // function. The fact layer follows those to the function they
  // resolve to.
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

function exportedCallConfigString(
  sourceFile: SourceFile,
  exportName: string,
  spec: { callees?: string[]; argIndex?: number; property: string },
  resolution?: ResolutionStore,
): string | null {
  const declarations = exportedDeclarationsOf(sourceFile).get(exportName);
  if (declarations === undefined) {
    return null;
  }

  const found = new Set<string>();
  for (const decl of declarations) {
    if (!Node.isVariableDeclaration(decl)) {
      continue;
    }
    const init = peelExpression(decl.getInitializer());
    if (init === undefined || !Node.isCallExpression(init)) {
      continue;
    }
    if (!calleeIsNamed(init.getExpression(), spec.callees)) {
      continue;
    }
    for (const arg of configArguments(init.getArguments(), spec.argIndex)) {
      const held = configString(arg, spec.property, resolution);
      if (held !== null) {
        found.add(held);
      }
    }
  }
  // Two answers mean the shape does not say which was meant, and the
  // same reasoning applies as everywhere else something reaches two
  // candidates: ambiguity is nothing.
  return found.size === 1 ? ([...found][0] as string) : null;
}

/** A callee the caller did not constrain matches whatever it is. */
function calleeIsNamed(callee: Node, names: string[] | undefined): boolean {
  if (names === undefined || names.length === 0) {
    return true;
  }
  return Node.isIdentifier(callee) && names.includes(callee.getText());
}

/** The arguments to read a config out of: one position, or all of them. */
function configArguments(args: Node[], argIndex: number | undefined): Node[] {
  if (argIndex === undefined) {
    return args;
  }
  const at = args[argIndex];
  return at === undefined ? [] : [at];
}

/** The string an argument's object holds under `property`. */
function configString(
  arg: Node,
  property: string,
  resolution?: ResolutionStore,
): string | null {
  const config = toObjectLiteral(arg, resolution);
  if (config === null) {
    return null;
  }
  const prop = config.getProperty(property);
  if (prop === undefined || !Node.isPropertyAssignment(prop)) {
    return null;
  }
  const value = peelExpression(prop.getInitializer());
  if (value !== undefined && Node.isStringLiteral(value)) {
    return value.getLiteralValue();
  }
  return null;
}

/**
 * Strip the wrappers that change a value's type without changing the
 * value: `as const` / `as T`, `satisfies T`, parentheses, and `!`.
 */
function peelExpression(node: Node | undefined): Node | undefined {
  let current = node;
  while (
    current !== undefined &&
    (Node.isAsExpression(current) ||
      Node.isSatisfiesExpression(current) ||
      Node.isParenthesizedExpression(current) ||
      Node.isNonNullExpression(current))
  ) {
    current = current.getExpression();
  }
  return current;
}

/**
 * The object literal a value is, or resolves to through the fact
 * layer (a config built in a shared constant or another file).
 */
function toObjectLiteral(
  node: Node,
  resolution?: ResolutionStore,
): ObjectLiteralExpression | null {
  const peeled = peelExpression(node);
  if (peeled === undefined) {
    return null;
  }
  if (Node.isObjectLiteralExpression(peeled)) {
    return peeled;
  }
  if (resolution === undefined) {
    return null;
  }
  const resolved = resolution.resolveObject(peeled);
  if (resolved !== null && Node.isObjectLiteralExpression(resolved)) {
    return resolved;
  }
  return null;
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
