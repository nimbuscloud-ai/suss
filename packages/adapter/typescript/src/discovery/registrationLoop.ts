// registrationLoop.ts (discovery handler) — expand a `for-of` loop
// over a literal array of route specs into N virtual registrations.
//
// Recognized shape:
//
//   const routes = [
//     { method: "get", path: "/users", handler: getUsers },
//     ...
//   ];
//   for (const r of routes) app[r.method](r.path, r.handler);
//
// Iterable resolution: inline `ArrayLiteralExpression` or a
// single-hop `const`-bound identifier whose initializer is one.
// Each element must be an object literal with literal `method` /
// `path` and a `handler` value resolvable to a function.
//
// Body filter: the loop body must reference the loop variable in
// at least one CallExpression. Filters out unrelated loops without
// requiring the body's exact shape.

import {
  type ArrayLiteralExpression,
  type ForOfStatement,
  Node,
  type ObjectLiteralExpression,
  type SourceFile,
} from "ts-morph";

import type { DiscoveryPattern } from "@suss/extractor";
import type { FunctionRoot } from "../conditions.js";
import type { DiscoveredUnit } from "./shared.js";

type LoopMatch = Extract<
  DiscoveryPattern["match"],
  { type: "registrationLoop" }
>;

export function discoverRegistrationLoops(
  sourceFile: SourceFile,
  match: LoopMatch,
  kind: string,
): DiscoveredUnit[] {
  const results: DiscoveredUnit[] = [];

  sourceFile.forEachDescendant((node) => {
    if (!Node.isForOfStatement(node)) {
      return;
    }
    const expanded = tryExpandLoop(node, match, kind);
    if (expanded !== null) {
      results.push(...expanded);
    }
  });

  return results;
}

function tryExpandLoop(
  loop: ForOfStatement,
  match: LoopMatch,
  kind: string,
): DiscoveredUnit[] | null {
  const loopVar = loopVariableName(loop);
  if (loopVar === null) {
    return null;
  }
  if (!bodyReferencesLoopVar(loop, loopVar)) {
    return null;
  }
  const arrayLit = resolveIterableToArrayLiteral(loop);
  if (arrayLit === null) {
    return null;
  }

  const out: DiscoveredUnit[] = [];
  for (const element of arrayLit.getElements()) {
    if (!Node.isObjectLiteralExpression(element)) {
      continue;
    }
    const route = readRouteSpec(element, match.elementShape);
    if (route === null) {
      continue;
    }
    out.push({
      func: route.handler,
      kind,
      name: route.handlerName,
      routeInfo: { method: route.method.toUpperCase(), path: route.path },
    });
  }
  return out.length > 0 ? out : null;
}

function loopVariableName(loop: ForOfStatement): string | null {
  const initializer = loop.getInitializer();
  if (Node.isVariableDeclarationList(initializer)) {
    const decls = initializer.getDeclarations();
    if (decls.length !== 1) {
      return null;
    }
    const nameNode = decls[0]?.getNameNode();
    if (nameNode !== undefined && Node.isIdentifier(nameNode)) {
      return nameNode.getText();
    }
  }
  return null;
}

function bodyReferencesLoopVar(loop: ForOfStatement, name: string): boolean {
  const body = loop.getStatement();
  let referenced = false;
  body.forEachDescendant((node) => {
    if (referenced) {
      return;
    }
    if (!Node.isCallExpression(node)) {
      return;
    }
    node.forEachDescendant((inner) => {
      if (referenced) {
        return;
      }
      if (Node.isIdentifier(inner) && inner.getText() === name) {
        referenced = true;
      }
    });
  });
  return referenced;
}

function resolveIterableToArrayLiteral(
  loop: ForOfStatement,
): ArrayLiteralExpression | null {
  const expr = loop.getExpression();
  if (Node.isArrayLiteralExpression(expr)) {
    return expr;
  }
  if (Node.isIdentifier(expr)) {
    const symbol = expr.getSymbol();
    if (symbol === undefined) {
      return null;
    }
    for (const decl of symbol.getDeclarations()) {
      if (Node.isVariableDeclaration(decl)) {
        const init = decl.getInitializer();
        if (init !== undefined && Node.isArrayLiteralExpression(init)) {
          return init;
        }
      }
    }
  }
  return null;
}

function readRouteSpec(
  element: ObjectLiteralExpression,
  shape: LoopMatch["elementShape"],
): {
  method: string;
  path: string;
  handler: FunctionRoot;
  handlerName: string;
} | null {
  let method: string | null = null;
  let path: string | null = null;
  let handler: { func: FunctionRoot; name: string } | null = null;

  for (const prop of element.getProperties()) {
    if (Node.isMethodDeclaration(prop) && prop.getName() === shape.handlerKey) {
      handler = { func: prop as FunctionRoot, name: shape.handlerKey };
      continue;
    }
    if (!Node.isPropertyAssignment(prop)) {
      continue;
    }
    const name = prop.getName();
    const init = prop.getInitializer();
    if (init === undefined) {
      continue;
    }
    if (name === shape.methodKey) {
      method = readStringLiteralValue(init);
    } else if (name === shape.pathKey) {
      path = readStringLiteralValue(init);
    } else if (name === shape.handlerKey) {
      handler = resolveHandlerExpression(init);
    }
  }

  if (method === null || path === null || handler === null) {
    return null;
  }
  return { method, path, handler: handler.func, handlerName: handler.name };
}

function readStringLiteralValue(node: Node): string | null {
  if (
    Node.isStringLiteral(node) ||
    Node.isNoSubstitutionTemplateLiteral(node)
  ) {
    return node.getLiteralValue();
  }
  return null;
}

function resolveHandlerExpression(
  node: Node,
): { func: FunctionRoot; name: string } | null {
  if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
    return { func: node as FunctionRoot, name: node.getKindName() };
  }
  if (Node.isIdentifier(node)) {
    const name = node.getText();
    const symbol = node.getSymbol();
    if (symbol === undefined) {
      return null;
    }
    for (const decl of symbol.getDeclarations()) {
      if (Node.isFunctionDeclaration(decl)) {
        return { func: decl, name };
      }
      if (Node.isVariableDeclaration(decl)) {
        const init = decl.getInitializer();
        if (init === undefined) {
          continue;
        }
        if (Node.isArrowFunction(init) || Node.isFunctionExpression(init)) {
          return { func: init as FunctionRoot, name };
        }
      }
    }
  }
  return null;
}
