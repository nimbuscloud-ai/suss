// helperResolution.ts — follow a return statement through a project's own
// response helper to the envelope it builds.
//
// A handler rarely writes its response envelope at the return site:
//
//   return json(200, { status: "ok" });
//
// with `json` a few files away:
//
//   export function json(statusCode: number, payload: unknown) {
//     return { statusCode, headers: {...}, body: JSON.stringify(payload) };
//   }
//
// A pack cannot describe that helper. It does not know the name, since
// the next project calls it `respond`, and it does not know the argument
// order, since that is the author's choice. Guessing either produces a
// confident wrong answer: one service had every status and body swapped
// because the pack assumed `json(payload, status)`.
//
// What the pack does know is the shape the platform requires, and it
// already declares it: an object carrying `statusCode`. So rather than
// naming helpers, resolve through the call and apply that same
// declaration to the object the helper returns, carrying along which
// argument the caller supplied for each parameter.
//
// Out of scope here: a helper that branches into several returns. That is
// several envelopes, and this version says so rather than picking one.

import { Node, SyntaxKind } from "ts-morph";

import type {
  CallExpression,
  Expression,
  Identifier,
  ObjectLiteralExpression,
  ParameterDeclaration,
  Node as TsNode,
} from "ts-morph";

export type EnvelopeResolution =
  | {
      kind: "resolved";
      /** The object literal the helper returns. */
      returned: ObjectLiteralExpression;
      /** Parameter name to the argument the caller passed for it. */
      substitutions: Map<string, Expression>;
    }
  /**
   * The callee is not a project function whose envelope we can read, so
   * there is nothing to follow. The caller carries on with its own
   * matching.
   */
  | { kind: "notLocal" }
  /** The callee is ours and builds more than one envelope. */
  | { kind: "unreadable" };

/**
 * Follow a call in return position to the envelope its callee returns.
 */
export function resolveReturnedEnvelope(
  call: CallExpression,
): EnvelopeResolution {
  const callee = call.getExpression();
  if (!Node.isIdentifier(callee)) {
    return { kind: "notLocal" };
  }

  const helper = resolveLocalHelper(callee);
  if (helper.kind !== "local") {
    return helper.kind === "external"
      ? { kind: "notLocal" }
      : { kind: "unreadable" };
  }

  return {
    kind: "resolved",
    returned: helper.returned,
    substitutions: bindArguments(
      call.getArguments() as Expression[],
      helper.params,
    ),
  };
}

type LocalHelper =
  | {
      kind: "local";
      params: ParameterDeclaration[];
      returned: ObjectLiteralExpression;
    }
  | { kind: "external" }
  | { kind: "unreadable" };

/**
 * The callee's declaration, when it is a function in this project that
 * returns one object. Anything resolving into node_modules or an ambient
 * declaration comes back "external", where the pack's own description is
 * the right answer.
 *
 * Covers `function json(...)` and `const json = (...) => ...`, both of
 * which show up as a project's response helper.
 */
function resolveLocalHelper(callee: Identifier): LocalHelper {
  for (const declaration of declarationsFor(callee)) {
    const file = declaration.getSourceFile();
    if (file.isFromExternalLibrary()) {
      return { kind: "external" };
    }

    // A .d.ts describes a helper without saying what it does. When the
    // implementation sits next to it, which is how a compiled package in
    // a workspace ships, read that instead.
    if (file.isDeclarationFile()) {
      const implementation = implementationBeside(
        declaration,
        callee.getText(),
      );
      if (implementation === null) {
        return { kind: "external" };
      }
      const returned = soleReturnedObject(implementation);
      return returned === null
        ? { kind: "unreadable" }
        : {
            kind: "local",
            params: implementation.getParameters(),
            returned,
          };
    }

    const fn = asFunctionLike(declaration);
    if (fn === null) {
      continue;
    }
    // `declare function json(...)` has no body to read. It stands for
    // something defined elsewhere, so it belongs with the library case.
    if (fn.getBody() === undefined) {
      return { kind: "external" };
    }
    const returned = soleReturnedObject(fn);
    if (returned === null) {
      return { kind: "unreadable" };
    }
    return { kind: "local", params: fn.getParameters(), returned };
  }
  // Nothing resolved. Without the project's dependencies installed a
  // library import lands here too, so treat it as external and leave the
  // pack's description in charge.
  return { kind: "external" };
}

/**
 * The function a `.d.ts` describes, found in the implementation file
 * beside it. `response.d.ts` sits next to `response.js`, so the export
 * with the same name in that file is the one being described.
 */
function implementationBeside(
  declaration: TsNode,
  name: string,
): FunctionLike | null {
  const declarationPath = declaration.getSourceFile().getFilePath();
  const base = declarationPath.replace(/\.d\.[cm]?ts$/, "");
  const project = declaration.getProject();

  for (const extension of [".js", ".ts", ".mjs", ".cjs", ".mts", ".cts"]) {
    const source = project.getSourceFile(`${base}${extension}`);
    if (source === undefined) {
      continue;
    }
    for (const candidate of source.getFunctions()) {
      if (candidate.getName() === name) {
        return candidate;
      }
    }
    const variable = source.getVariableDeclaration(name);
    const fn = variable === undefined ? null : asFunctionLike(variable);
    if (fn !== null) {
      return fn;
    }
  }
  return null;
}

/** Declarations for an identifier, following an import to its source. */
function declarationsFor(callee: Identifier): TsNode[] {
  const symbol = callee.getSymbol();
  if (symbol === undefined) {
    return [];
  }
  const aliased = symbol.getAliasedSymbol();
  return (aliased ?? symbol).getDeclarations();
}

interface FunctionLike {
  getParameters(): ParameterDeclaration[];
  getBody(): TsNode | undefined;
}

function asFunctionLike(declaration: TsNode): FunctionLike | null {
  if (
    Node.isFunctionDeclaration(declaration) ||
    Node.isArrowFunction(declaration) ||
    Node.isFunctionExpression(declaration)
  ) {
    return declaration;
  }
  if (Node.isVariableDeclaration(declaration)) {
    const initializer = declaration.getInitializer();
    if (
      initializer !== undefined &&
      (Node.isArrowFunction(initializer) ||
        Node.isFunctionExpression(initializer))
    ) {
      return initializer;
    }
  }
  return null;
}

/** The object a helper returns, when it returns exactly one. */
function soleReturnedObject(fn: FunctionLike): ObjectLiteralExpression | null {
  const body = fn.getBody();
  if (body === undefined) {
    return null;
  }

  // Expression-bodied arrow: `(s, p) => ({ statusCode: s, body: p })`.
  // The parentheses are required by the grammar, so unwrap them.
  if (!Node.isBlock(body)) {
    const expression = unwrapParens(body);
    return Node.isObjectLiteralExpression(expression) ? expression : null;
  }

  // Every return in this function, not only the ones at the top level. A
  // helper that returns one envelope early and another at the end builds
  // two, and reading only the last would report the wrong one.
  const returns = body
    .getDescendantsOfKind(SyntaxKind.ReturnStatement)
    .filter((statement) => enclosingFunctionOf(statement) === body);
  if (returns.length !== 1) {
    return null;
  }
  const expression = returns[0]?.getExpression();
  if (expression === undefined) {
    return null;
  }
  const unwrapped = unwrapParens(expression);
  return Node.isObjectLiteralExpression(unwrapped) ? unwrapped : null;
}

function unwrapParens(node: TsNode): TsNode {
  return Node.isParenthesizedExpression(node)
    ? unwrapParens(node.getExpression())
    : node;
}

/**
 * The body block a statement belongs to, skipping past any nested
 * function. A `return` inside a callback yields the callback's value,
 * not the helper's, so it must not count as one of the helper's
 * envelopes.
 */
function enclosingFunctionOf(node: TsNode): TsNode | undefined {
  let current = node.getParent();
  while (current !== undefined) {
    if (
      Node.isFunctionDeclaration(current) ||
      Node.isArrowFunction(current) ||
      Node.isFunctionExpression(current) ||
      Node.isMethodDeclaration(current)
    ) {
      return current.getBody();
    }
    current = current.getParent();
  }
  return undefined;
}

/**
 * Line the call's arguments up with the helper's parameters.
 *
 * A parameter the caller omitted takes its default, which is the value
 * that call actually produces: `redirect(url, cookie)` against
 * `(location, cookie?, status = 302)` redirects with 302, and reporting
 * nothing there would lose a status the code plainly states.
 */
function bindArguments(
  callArgs: ReadonlyArray<Expression>,
  params: ReadonlyArray<ParameterDeclaration>,
): Map<string, Expression> {
  const bound = new Map<string, Expression>();
  for (const [index, param] of params.entries()) {
    const supplied = callArgs[index] ?? param.getInitializer();
    if (supplied !== undefined) {
      bound.set(param.getName(), supplied);
    }
  }
  return bound;
}
