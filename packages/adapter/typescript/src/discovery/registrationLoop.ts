// registrationLoop.ts (discovery handler): expand a `for-of` loop
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
// The iterable and each element's handler are asked of the fact
// layer, so an array of routes shared between modules reads the same
// as one written above the loop. Each element must be an object
// literal with a literal `method` and `path`.
//
// Body filter: the loop body must reference the loop variable in
// at least one CallExpression. Filters out unrelated loops without
// requiring the body's exact shape.

import { type ForOfStatement, Node, type SourceFile } from "ts-morph";

import { registrationSubjectsOf } from "./registrationCall.js";
import {
  arrayLiteralOf,
  functionValueOf,
  objectLiteralOf,
} from "./resolveValue.js";

import type { DiscoveryPattern } from "@suss/extractor";
import type { ObjectLiteralExpression } from "ts-morph";
import type { FunctionRoot } from "../conditions.js";
import type { ResolutionStore } from "../facts/store.js";
import type { DiscoveredUnit } from "./shared.js";

type LoopMatch = Extract<
  DiscoveryPattern["match"],
  { type: "registrationLoop" }
>;

export function discoverRegistrationLoops(
  sourceFile: SourceFile,
  match: LoopMatch,
  kind: string,
  resolution?: ResolutionStore,
): DiscoveredUnit[] {
  const results: DiscoveredUnit[] = [];

  const routables = routableNames(sourceFile, match);
  if (routables !== null && routables.size === 0) {
    // The pack asked for a receiver and this file constructs none, so
    // no loop in it registers routes on one.
    return results;
  }

  sourceFile.forEachDescendant((node) => {
    if (!Node.isForOfStatement(node)) {
      return;
    }
    const expanded = tryExpandLoop(node, match, kind, resolution, routables);
    if (expanded !== null) {
      results.push(...expanded);
    }
  });

  return results;
}

/**
 * The variables in this file the pack's receiver declaration picks
 * out, or null when the pattern declares no receiver and any subject
 * is accepted.
 */
function routableNames(
  sourceFile: SourceFile,
  match: LoopMatch,
): Set<string> | null {
  if (match.receiver === undefined) {
    return null;
  }
  const names = new Set<string>();
  for (const importName of match.receiver.importNames) {
    for (const name of registrationSubjectsOf(
      sourceFile,
      match.receiver.importModule,
      importName,
    ).keys()) {
      names.add(name);
    }
  }
  return names;
}

function tryExpandLoop(
  loop: ForOfStatement,
  match: LoopMatch,
  kind: string,
  resolution: ResolutionStore | undefined,
  routables: Set<string> | null,
): DiscoveredUnit[] | null {
  const loopVar = loopVariableName(loop);
  if (loopVar === null) {
    return null;
  }
  if (!bodyReferencesLoopVar(loop, loopVar)) {
    return null;
  }
  if (routables !== null && !bodyCallsOn(loop, routables)) {
    // A loop over objects with the right keys that never touches the
    // routable registers nothing, and expanding it would report routes
    // the server does not serve.
    return null;
  }
  const arrayLit = arrayLiteralOf(loop.getExpression(), resolution);
  if (arrayLit === null) {
    return null;
  }

  const out: DiscoveredUnit[] = [];
  for (const element of arrayLit.getElements()) {
    const spec = objectLiteralOf(element, resolution);
    if (spec === null) {
      continue;
    }
    const route = readRouteSpec(spec, match.elementShape, resolution);
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

/**
 * Whether the body calls a method on one of the named variables,
 * through a property (`app.get(...)`) or an element access
 * (`app[r.method](...)`).
 */
function bodyCallsOn(loop: ForOfStatement, routables: Set<string>): boolean {
  let found = false;
  loop.getStatement().forEachDescendant((node) => {
    if (found || !Node.isCallExpression(node)) {
      return;
    }
    const callee = node.getExpression();
    const subject =
      Node.isPropertyAccessExpression(callee) ||
      Node.isElementAccessExpression(callee)
        ? callee.getExpression()
        : null;
    if (
      subject !== null &&
      Node.isIdentifier(subject) &&
      routables.has(subject.getText())
    ) {
      found = true;
    }
  });
  return found;
}

function readRouteSpec(
  element: ObjectLiteralExpression,
  shape: LoopMatch["elementShape"],
  resolution: ResolutionStore | undefined,
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
      const func = functionValueOf(init, resolution);
      handler = func === null ? null : { func, name: handlerName(init) };
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

/**
 * What to call the handler an element is. A name is used where
 * there is one; a function written out in the array has none, and the
 * kind is what the unit has carried there since this handler was
 * written.
 */
function handlerName(value: Node): string {
  return Node.isIdentifier(value) ? value.getText() : value.getKindName();
}
