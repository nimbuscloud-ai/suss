// subUnitContext.ts — Primitives the TypeScript adapter exposes to
// packs whose `subUnits` hook needs to walk the parent's AST.
//
// The PatternPack.subUnits signature in @suss/extractor takes `ctx:
// unknown` because the extractor has no knowledge of which adapter is
// driving. Each adapter defines its own context type; packs cast to
// the adapter context they're written against ("I expect the
// TypeScript adapter"). The primitives here are enough to cover React
// event-handler prop discovery and React/Node event-subscription call
// discovery — both expressions of "runtime schedules user callbacks."
//
// Keep primitives narrow: they do AST-shape inspection and return
// either concrete JS types (string, string[]) or opaque AST handles
// (FunctionRoot, Node). Packs don't manipulate ts-morph directly from
// here — they receive handles and pass them back via the context.

import {
  type ArrayLiteralExpression,
  type CallExpression,
  type JsxExpression,
  Node,
} from "ts-morph";

import type { FunctionRoot } from "./conditions.js";

/**
 * The context the TypeScript adapter passes to a pack's `subUnits`
 * hook. Covers JSX-attribute-walking and call-expression-walking plus
 * the resolution helpers packs need to map AST nodes back to function
 * bodies and source text.
 *
 * All walks are scoped to the parent function and deliberately do NOT
 * recurse into nested function bodies — sub-units of nested functions
 * belong to those functions' summaries, not to the enclosing parent.
 */
export interface TsSubUnitContext {
  /**
   * Yield every JSX attribute on every JSX element / self-closing
   * element in the parent's body, excluding any inside nested
   * function bodies. The tag is the source text of the element's
   * tag-name node.
   */
  findJsxAttributes(parent: FunctionRoot): TsJsxAttributeLocation[];

  /**
   * Yield every call expression matching `name` (bare identifier
   * callee only — e.g. `useEffect(...)`, not `React.useEffect(...)`).
   * Nested function bodies are skipped.
   */
  findCallExpressionsByName(
    parent: FunctionRoot,
    name: string,
  ): CallExpression[];

  /**
   * Resolve a JSX attribute's value to a function body, if the value
   * is (a) an inline arrow or function expression or (b) an
   * identifier referring to a function declared inside the parent.
   * Returns null for prop-delegating references (`props.onClick`),
   * identifiers that resolve outside the parent's scope, or any
   * non-function expression.
   */
  resolveAttributeValueFunction(
    attr: TsJsxAttributeLocation,
    parent: FunctionRoot,
  ): { func: FunctionRoot; localName: string | null } | null;

  /**
   * Return the Nth argument of a call as a function body, if it's an
   * inline arrow or function expression. Returns null for identifier
   * references, property accesses, or non-function values.
   */
  getCallArgumentFunction(
    call: CallExpression,
    position: number,
  ): FunctionRoot | null;

  /**
   * Return the Nth argument raw node (or null if absent).
   */
  getCallArgument(call: CallExpression, position: number): Node | null;

  /**
   * If `node` is an array literal expression, return each element's
   * source text. If it's some other expression, return a single entry
   * with the node's full text. Null means no deps argument was given.
   */
  readArrayLiteralText(node: Node | null): string[] | null;
}

/**
 * A located JSX attribute: which element it's on, its name, and the
 * expression node supplying its value (null for boolean-shorthand
 * attributes like `<input disabled>`).
 */
export interface TsJsxAttributeLocation {
  tag: string;
  name: string;
  valueExpression: Node | null;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function createTsSubUnitContext(): TsSubUnitContext {
  return {
    findJsxAttributes,
    findCallExpressionsByName,
    resolveAttributeValueFunction,
    getCallArgumentFunction,
    getCallArgument,
    readArrayLiteralText,
  };
}

function skipNestedFunctions(parent: FunctionRoot) {
  return (node: Node, traversal: { skip: () => void }): boolean => {
    if (
      node !== parent &&
      (Node.isFunctionDeclaration(node) ||
        Node.isFunctionExpression(node) ||
        Node.isArrowFunction(node) ||
        Node.isMethodDeclaration(node))
    ) {
      traversal.skip();
      return true;
    }
    return false;
  };
}

function findJsxAttributes(parent: FunctionRoot): TsJsxAttributeLocation[] {
  const out: TsJsxAttributeLocation[] = [];
  const skip = skipNestedFunctions(parent);

  parent.forEachDescendant((node, traversal) => {
    if (skip(node, traversal)) {
      return;
    }
    if (
      !Node.isJsxOpeningElement(node) &&
      !Node.isJsxSelfClosingElement(node)
    ) {
      return;
    }
    const tag = node.getTagNameNode().getText();
    for (const attr of node.getAttributes()) {
      if (!Node.isJsxAttribute(attr)) {
        continue;
      }
      const initializer = attr.getInitializer();
      let valueExpression: Node | null = null;
      if (initializer !== undefined) {
        if (Node.isJsxExpression(initializer)) {
          const inner = (initializer as JsxExpression).getExpression();
          valueExpression = inner ?? null;
        } else {
          // String-literal-valued attributes (`type="button"`) —
          // rarely interesting for subUnits, but exposing the node
          // keeps the interface complete.
          valueExpression = initializer;
        }
      }
      out.push({
        tag,
        name: attr.getNameNode().getText(),
        valueExpression,
      });
    }
  });

  return out;
}

function findCallExpressionsByName(
  parent: FunctionRoot,
  name: string,
): CallExpression[] {
  const out: CallExpression[] = [];
  const skip = skipNestedFunctions(parent);

  parent.forEachDescendant((node, traversal) => {
    if (skip(node, traversal)) {
      return;
    }
    if (!Node.isCallExpression(node)) {
      return;
    }
    const callee = node.getExpression();
    if (Node.isIdentifier(callee) && callee.getText() === name) {
      out.push(node);
    }
  });

  return out;
}

function resolveAttributeValueFunction(
  attr: TsJsxAttributeLocation,
  parent: FunctionRoot,
): { func: FunctionRoot; localName: string | null } | null {
  const expr = attr.valueExpression;
  if (expr === null) {
    return null;
  }

  if (Node.isArrowFunction(expr) || Node.isFunctionExpression(expr)) {
    return { func: expr as FunctionRoot, localName: null };
  }

  if (Node.isIdentifier(expr)) {
    const symbol = expr.getSymbol();
    if (symbol === undefined) {
      return null;
    }
    for (const decl of symbol.getDeclarations()) {
      if (!isWithinFunction(decl, parent)) {
        continue;
      }
      const fn = tryExtractFunction(decl);
      if (fn !== null) {
        return { func: fn, localName: expr.getText() };
      }
    }
    return null;
  }

  return null;
}

function tryExtractFunction(decl: Node): FunctionRoot | null {
  if (Node.isFunctionDeclaration(decl)) {
    return decl;
  }
  if (Node.isVariableDeclaration(decl)) {
    const init = decl.getInitializer();
    if (init === undefined) {
      return null;
    }
    if (Node.isArrowFunction(init) || Node.isFunctionExpression(init)) {
      return init as FunctionRoot;
    }
  }
  return null;
}

function isWithinFunction(node: Node, func: FunctionRoot): boolean {
  let current: Node | undefined = node.getParent();
  while (current !== undefined) {
    if (current === func) {
      return true;
    }
    current = current.getParent();
  }
  return false;
}

function getCallArgumentFunction(
  call: CallExpression,
  position: number,
): FunctionRoot | null {
  const arg = call.getArguments()[position];
  if (arg === undefined) {
    return null;
  }
  if (Node.isArrowFunction(arg) || Node.isFunctionExpression(arg)) {
    return arg as FunctionRoot;
  }
  return null;
}

function getCallArgument(call: CallExpression, position: number): Node | null {
  return call.getArguments()[position] ?? null;
}

function readArrayLiteralText(node: Node | null): string[] | null {
  if (node === null) {
    return null;
  }
  if (Node.isArrayLiteralExpression(node)) {
    return (node as ArrayLiteralExpression)
      .getElements()
      .map((e) => e.getText());
  }
  // Non-array deps argument — record the whole expression as a single
  // dep-text entry so provenance isn't lost.
  return [node.getText()];
}
