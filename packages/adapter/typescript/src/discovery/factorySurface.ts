// factorySurface.ts: surface the public callable surface of a
// factory function or class declaration. Used by packageExports
// discovery to emit one library unit per method on top of the
// single unit for the export itself.
//
// Shapes covered:
//
// 1. Object-literal returns from a factory:
//      function createX() {
//        return { method() {}, prop: () => {} }
//      }
//    Each property a function is behind becomes a surfaced method,
//    whether written there or named (`return { project }`). A spread
//    contributes the properties of what it spreads.
//
// 2. A factory that returns through a same-file helper:
//      function createX(spec) { return build(spec); }
//      function build(spec) { return { method() {} }; }
//    `build`'s own return is surfaced as `createX`'s, bounded by
//    MAX_BUILDER_HOPS so a helper that returns another call into
//    itself terminates.
//
// 3. Class declarations:
//      export class ApiClient {
//        get() {}
//        static create() {}
//      }
//    Each public instance method and public static method becomes a
//    surfaced method. Constructors, getters, setters, and private
//    members are skipped.
//
// Out of scope: a returned local assigned from a call in another
// file, a method that exists only on the declared return type (a
// `safeParse` reached through a zod type), conditional returns where
// branches return different shapes, and generic factory chains.

import { Node, SyntaxKind } from "ts-morph";

import { functionTargetOf } from "../resolve/functionBehind.js";
import { peelParens } from "../walk/unwrap.js";
import {
  propertiesOf,
  propertyFunctionOf,
  propertyNameOf,
} from "./resolveValue.js";

import type {
  ClassDeclaration,
  Identifier,
  ObjectLiteralExpression,
  ReturnStatement,
} from "ts-morph";
import type { FunctionRoot } from "../conditions.js";
import type { ResolutionStore } from "../facts/store.js";

// One hop covers every same-file builder in the dogfood run; the bound
// stops a helper whose return calls back into itself from recursing.
const MAX_BUILDER_HOPS = 2;

export interface SurfacedMethod {
  func: FunctionRoot;
  name: string;
}

export function surfaceMethods(
  decl: Node,
  resolution?: ResolutionStore,
): SurfacedMethod[] {
  if (Node.isClassDeclaration(decl)) {
    return surfaceClassMethods(decl);
  }
  if (
    Node.isFunctionDeclaration(decl) ||
    Node.isFunctionExpression(decl) ||
    Node.isArrowFunction(decl) ||
    Node.isMethodDeclaration(decl)
  ) {
    return surfaceFactoryReturnMethods(decl as FunctionRoot, resolution);
  }
  return [];
}

function surfaceClassMethods(cls: ClassDeclaration): SurfacedMethod[] {
  const out: SurfacedMethod[] = [];
  const seen = new Set<string>();

  for (const method of cls.getInstanceMethods()) {
    if (method.hasModifier(SyntaxKind.PrivateKeyword)) {
      continue;
    }
    const name = method.getName();
    if (name.startsWith("#") || seen.has(name)) {
      continue;
    }
    seen.add(name);
    out.push({ func: method as FunctionRoot, name });
  }
  for (const method of cls.getStaticMethods()) {
    if (method.hasModifier(SyntaxKind.PrivateKeyword)) {
      continue;
    }
    const name = method.getName();
    if (name.startsWith("#") || seen.has(name)) {
      continue;
    }
    seen.add(name);
    out.push({ func: method as FunctionRoot, name });
  }
  return out;
}

function surfaceFactoryReturnMethods(
  fn: FunctionRoot,
  resolution: ResolutionStore | undefined,
): SurfacedMethod[] {
  const out: SurfacedMethod[] = [];
  const seen = new Set<string>();
  collectFromFunctionReturns(fn, out, seen, 0, resolution);
  return out;
}

/**
 * Every return value of `fn`, fed to `collectFromReturnValue`. Shared
 * by the entry-point factory and, one or two hops in, by a same-file
 * helper its return calls into.
 */
function collectFromFunctionReturns(
  fn: FunctionRoot,
  out: SurfacedMethod[],
  seen: Set<string>,
  depth: number,
  resolution: ResolutionStore | undefined,
): void {
  // Concise-arrow body: `() => ({ method() {} })`.
  // ts-morph's getBody() returns the expression directly for these.
  if (Node.isArrowFunction(fn)) {
    const body = fn.getBody();
    if (Node.isExpression(body)) {
      collectFromReturnValue(body, out, seen, depth, resolution);
      return;
    }
  }

  // Block body: walk for ReturnStatement, skipping nested function
  // bodies. A nested helper's `return { ... }` doesn't belong to the
  // outer factory's surface.
  const body = fn.getBody?.();
  if (body === undefined) {
    return;
  }

  const returns: ReturnStatement[] = [];
  body.forEachDescendant((node, traversal) => {
    if (
      Node.isFunctionDeclaration(node) ||
      Node.isFunctionExpression(node) ||
      Node.isArrowFunction(node) ||
      Node.isMethodDeclaration(node) ||
      Node.isConstructorDeclaration(node) ||
      Node.isGetAccessorDeclaration(node) ||
      Node.isSetAccessorDeclaration(node)
    ) {
      traversal.skip();
      return;
    }
    if (Node.isReturnStatement(node)) {
      returns.push(node);
    }
  });

  for (const ret of returns) {
    const expr = ret.getExpression();
    if (expr === undefined) {
      continue;
    }
    collectFromReturnValue(expr, out, seen, depth, resolution);
  }
}

/**
 * An object literal returned directly surfaces its methods. A call to
 * a same-file function, within MAX_BUILDER_HOPS, surfaces whatever
 * that function's own return surfaces instead.
 */
function collectFromReturnValue(
  node: Node,
  out: SurfacedMethod[],
  seen: Set<string>,
  depth: number,
  resolution: ResolutionStore | undefined,
): void {
  const expr = peelParens(node);
  if (Node.isObjectLiteralExpression(expr)) {
    collectFromObjectLiteral(expr, out, seen, resolution);
    return;
  }

  if (depth >= MAX_BUILDER_HOPS || !Node.isCallExpression(expr)) {
    return;
  }
  const callee = expr.getExpression();
  if (!Node.isIdentifier(callee)) {
    return;
  }
  const helper = sameFileFunctionBehind(callee);
  if (helper !== null) {
    collectFromFunctionReturns(helper, out, seen, depth + 1, resolution);
  }
}

/**
 * The function declaration, function expression, or arrow that `id`
 * binds to, when it is declared in the same file. Null for a binding
 * from another file (an import) or anything not a plain function.
 */
function sameFileFunctionBehind(id: Identifier): FunctionRoot | null {
  const target = functionTargetOf(id);
  if (target === null || target.file !== id.getSourceFile().getFilePath()) {
    return null;
  }
  return target.func;
}

/**
 * Every property of the returned object that a function is behind. A
 * getter or setter has no name here, and neither does a spread, whose
 * own properties are walked in its place.
 */
function collectFromObjectLiteral(
  object: ObjectLiteralExpression,
  out: SurfacedMethod[],
  seen: Set<string>,
  resolution: ResolutionStore | undefined,
): void {
  for (const property of propertiesOf(object, resolution)) {
    const name = propertyNameOf(property);
    if (name === null || seen.has(name)) {
      continue;
    }
    const func = propertyFunctionOf(property, resolution);
    if (func === null) {
      continue;
    }
    seen.add(name);
    out.push({ func, name });
  }
}
