/**
 * The one resolver from a reference to the function behind it.
 *
 * Four copies of "follow an identifier to its function declaration"
 * grew across the closure, the render-tree builder, the react pack,
 * and the parameter-read walk, three of them lossy (#674). The walk
 * lives here: alias-following through imports, shorthand properties
 * resolved to the binding they read, overload signatures routed to
 * the declaration with the body, and external code refused. Callers
 * that need only the file and name take `functionTargetOf`; the
 * closure takes `resolveDecl` for the function root itself.
 */

import { Node } from "ts-morph";

import { toFunctionRoot } from "../discovery/index.js";
import {
  declarationsBehind,
  hasBody,
  isInExternalCode,
} from "./unfollowedCall.js";

import type { CallExpression, Identifier, Symbol as TsSymbol } from "ts-morph";
import type { FunctionRoot } from "../conditions.js";

export interface ReachableCandidate {
  func: FunctionRoot;
  name: string;
}

/**
 * The callee as one line. A call written across several lines would
 * otherwise put its own newlines into the text a gap quotes and the
 * text an invocation effect is matched by.
 */
export function normalizeCallee(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The first of these declarations the walk can follow into. */
export function functionAmong(
  declarations: readonly Node[],
  calleeName: string,
): ReachableCandidate | null {
  for (const decl of declarations) {
    const resolved = resolveDecl(decl, calleeName);
    if (resolved !== null) {
      return resolved;
    }
  }
  return null;
}

/**
 * The project function a call comes down to, or null when a dependency
 * declares the callee and this run never read it.
 */
export function functionCalledAt(
  call: CallExpression,
): ReachableCandidate | null {
  const callee = call.getExpression();
  return functionAmong(
    declarationsBehind(callee.getSymbol()),
    normalizeCallee(callee.getText()),
  );
}

/**
 * The symbol a reference resolves to. A shorthand property
 * (`{ roomId }`) gives its identifier the property's symbol, and the
 * local binding it reads is behind `getValueSymbol`.
 */
export function symbolBehind(node: Identifier): TsSymbol | undefined {
  const parent = node.getParent();
  if (parent !== undefined && Node.isShorthandPropertyAssignment(parent)) {
    return parent.getValueSymbol();
  }
  return node.getSymbol();
}

/**
 * The function an identifier refers to, as its declaration's file and
 * name, for joins that never walk the body. Null when the reference
 * does not land on a project function.
 */
export function functionTargetOf(
  node: Identifier,
): { func: FunctionRoot; file: string; name: string } | null {
  const resolved = functionAmong(
    declarationsBehind(symbolBehind(node)),
    node.getText(),
  );
  if (resolved === null) {
    return null;
  }
  return {
    func: resolved.func,
    file: resolved.func.getSourceFile().getFilePath(),
    name: resolved.name,
  };
}

/**
 * Follow a declaration node to an underlying function-shaped declaration
 * we can extract from. Returns null for declarations that don't resolve
 * (namespaces, classes without a called method, external-module imports,
 * parameters, etc.): the closure skips those.
 */
export function resolveDecl(
  decl: Node,
  calleeName: string,
): ReachableCandidate | null {
  if (isInExternalCode(decl.getSourceFile())) {
    return null;
  }
  const fn = toFunctionRoot(decl);
  if (fn !== null) {
    if (!hasBody(fn)) {
      return null;
    }
    return { func: fn, name: declName(decl) ?? calleeName };
  }
  if (Node.isVariableDeclaration(decl)) {
    const init = decl.getInitializer();
    if (
      init !== undefined &&
      (Node.isArrowFunction(init) || Node.isFunctionExpression(init))
    ) {
      return { func: init as FunctionRoot, name: decl.getName() };
    }
    return null;
  }
  return null;
}

/**
 * Best-effort name extraction for a reached declaration: used for
 * `summary.identity.name`. FunctionDeclaration / MethodDeclaration have
 * a direct name. Arrow/function expressions bound to a variable borrow
 * the variable name.
 */
function declName(decl: Node): string | null {
  if (Node.isFunctionDeclaration(decl) || Node.isMethodDeclaration(decl)) {
    const n = decl.getName?.();
    if (typeof n === "string" && n.length > 0) {
      return n;
    }
  }
  if (Node.isFunctionExpression(decl)) {
    const n = decl.getName();
    if (typeof n === "string" && n.length > 0) {
      return n;
    }
  }
  const parent = decl.getParent();
  if (parent !== undefined && Node.isVariableDeclaration(parent)) {
    return parent.getName();
  }
  return null;
}
