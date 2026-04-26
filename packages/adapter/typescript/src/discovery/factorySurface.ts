// factorySurface.ts — surface the public callable surface of a
// factory function or class declaration. Used by packageExports
// discovery to emit one library unit per method on top of the
// single unit for the export itself.
//
// Two shapes covered:
//
// 1. Object-literal returns from a factory:
//      function createX() {
//        return { method() {}, prop: () => {} }
//      }
//    Each property whose value is a function expression / arrow /
//    method-shorthand becomes a surfaced method. Shorthand value
//    properties (`return { project }`), spreads (`return { ...x }`),
//    and non-callable values are skipped.
//
// 2. Class declarations:
//      export class ApiClient {
//        get() {}
//        static create() {}
//      }
//    Each public instance method and public static method becomes a
//    surfaced method. Constructors, getters, setters, and private
//    members are skipped.
//
// Out of scope: factories returning a value resolved through type
// inference (`return adapter` where `adapter` is a local), conditional
// returns where branches return different shapes, generic factory
// chains.

import { Node, SyntaxKind } from "ts-morph";

import type { ClassDeclaration, ReturnStatement } from "ts-morph";
import type { FunctionRoot } from "../conditions.js";

export interface SurfacedMethod {
  func: FunctionRoot;
  name: string;
}

export function surfaceMethods(decl: Node): SurfacedMethod[] {
  if (Node.isClassDeclaration(decl)) {
    return surfaceClassMethods(decl);
  }
  if (
    Node.isFunctionDeclaration(decl) ||
    Node.isFunctionExpression(decl) ||
    Node.isArrowFunction(decl) ||
    Node.isMethodDeclaration(decl)
  ) {
    return surfaceFactoryReturnMethods(decl as FunctionRoot);
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

function surfaceFactoryReturnMethods(fn: FunctionRoot): SurfacedMethod[] {
  const out: SurfacedMethod[] = [];
  const seen = new Set<string>();

  // Concise-arrow body: `() => ({ method() {} })`.
  // ts-morph's getBody() returns the expression directly for these.
  if (Node.isArrowFunction(fn)) {
    const body = fn.getBody();
    if (Node.isExpression(body)) {
      collectFromObjectLiteral(body, out, seen);
      return out;
    }
  }

  // Block body: walk for ReturnStatement, skipping nested function
  // bodies. A nested helper's `return { ... }` doesn't belong to the
  // outer factory's surface.
  const body = fn.getBody?.();
  if (body === undefined) {
    return out;
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
    collectFromObjectLiteral(expr, out, seen);
  }

  return out;
}

function collectFromObjectLiteral(
  node: Node,
  out: SurfacedMethod[],
  seen: Set<string>,
): void {
  let e = node;
  while (Node.isParenthesizedExpression(e)) {
    e = e.getExpression();
  }
  if (!Node.isObjectLiteralExpression(e)) {
    return;
  }
  for (const prop of e.getProperties()) {
    if (Node.isMethodDeclaration(prop)) {
      const name = prop.getName();
      if (seen.has(name)) {
        continue;
      }
      seen.add(name);
      out.push({ func: prop as FunctionRoot, name });
      continue;
    }
    if (Node.isPropertyAssignment(prop)) {
      const init = prop.getInitializer();
      if (init === undefined) {
        continue;
      }
      let v = init;
      while (Node.isParenthesizedExpression(v)) {
        v = v.getExpression();
      }
      if (Node.isArrowFunction(v) || Node.isFunctionExpression(v)) {
        const name = prop.getName();
        if (seen.has(name)) {
          continue;
        }
        seen.add(name);
        out.push({ func: v as FunctionRoot, name });
      }
    }
    // ShorthandPropertyAssignment (`{ project }`) — value is a local
    // binding, not a callable property literal. Skip; tracking what
    // local resolves to a callable is out of v0 scope.
    // SpreadAssignment (`{ ...other }`) — opaque source object.
    // GetAccessor/SetAccessor — not callable in the method-call sense.
  }
}
