// helperResolution.ts — follow a return statement into the helper it
// calls, and read what that helper returns.
//
// A handler usually builds its response in a helper rather than at the
// return site:
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
// What a pack does know is the shape the platform requires, and it
// already declares it: an object carrying `statusCode`. So instead of
// naming helpers, follow the call and apply that declaration to what the
// helper returns, carrying along which argument the caller passed for
// each parameter.
//
// A helper that branches returns more than one value, and each becomes
// its own transition. Branches that cannot run at a given call site are
// left out.

import { Node, SyntaxKind } from "ts-morph";

import { peelParens } from "../walk/unwrap.js";

import type {
  CallExpression,
  Expression,
  Identifier,
  ObjectLiteralExpression,
  ParameterDeclaration,
  Node as TsNode,
} from "ts-morph";

export type HelperResolution =
  | {
      kind: "resolved";
      /**
       * Every value the helper can return, in source order. A helper
       * that branches returns more than one, and each becomes its own
       * transition, which is how the IR expresses alternatives.
       *
       * A branch that cannot run once the caller's arguments are bound
       * is left out: `if (status > 399)` does not run when the caller
       * passed 200.
       */
      returnValues: ObjectLiteralExpression[];
      /** Parameter name to the argument the caller passed for it. */
      substitutions: Map<string, Expression>;
    }
  /**
   * The callee is not a function in this project, so there is nothing to
   * follow. The caller carries on with its own matching.
   */
  | { kind: "notLocal" }
  /** The callee is in this project, and nothing in it could be read. */
  | { kind: "unreadable" };

/** Follow a call in return position and read what the callee returns. */
export function resolveHelperReturn(call: CallExpression): HelperResolution {
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

  const substitutions = bindArguments(
    call.getArguments() as Expression[],
    helper.params,
  );
  const returnValues = helper.returnValues.filter((value) =>
    branchCanRun(value, substitutions),
  );

  return returnValues.length === 0
    ? { kind: "unreadable" }
    : { kind: "resolved", returnValues, substitutions };
}

/**
 * Can the branch holding this return statement run, given what the
 * caller passed? False means it cannot, so the branch is dead at this
 * call site. True covers both "it runs" and "cannot tell", which are the
 * same instruction: keep the branch.
 *
 * Only a comparison between a bound parameter and a number is decided,
 * which is the shape a status guard takes. Anything else keeps its
 * branch: dropping one wrongly loses behaviour, while keeping one
 * needlessly costs an extra transition.
 */
function branchCanRun(
  returnValue: ObjectLiteralExpression,
  substitutions: ReadonlyMap<string, Expression>,
): boolean {
  for (const guard of guardsAbove(returnValue)) {
    const holds = evaluateComparison(guard.condition, substitutions);
    if (holds !== null && holds !== guard.whenTrue) {
      return false;
    }
  }
  return true;
}

/**
 * Everything that has to be true for this return to run.
 *
 * Two sources. An enclosing `if` contributes its condition, true or
 * false depending on which arm the return sits in. And an earlier `if`
 * in the same block that returns contributes its condition negated,
 * because reaching anything after an early return means that guard did
 * not hold:
 *
 *   if (statusCode > 399) { return ... }   // needs the guard true
 *   return ...                             // needs the guard false
 */
function guardsAbove(
  returnValue: ObjectLiteralExpression,
): Array<{ condition: TsNode; whenTrue: boolean }> {
  const guards: Array<{ condition: TsNode; whenTrue: boolean }> = [];
  let child: TsNode = returnValue;
  let current: TsNode | undefined = returnValue.getParent();

  while (current !== undefined) {
    if (Node.isIfStatement(current)) {
      guards.push({
        condition: current.getExpression(),
        whenTrue: current.getThenStatement() === child,
      });
    }
    if (Node.isBlock(current)) {
      guards.push(...earlyReturnGuardsBefore(current, child));
    }
    if (
      Node.isFunctionDeclaration(current) ||
      Node.isArrowFunction(current) ||
      Node.isFunctionExpression(current)
    ) {
      break;
    }
    child = current;
    current = current.getParent();
  }
  return guards;
}

/** Earlier `if (…) { return … }` statements in `block`, before `child`. */
function earlyReturnGuardsBefore(
  block: TsNode,
  child: TsNode,
): Array<{ condition: TsNode; whenTrue: boolean }> {
  if (!Node.isBlock(block)) {
    return [];
  }
  const guards: Array<{ condition: TsNode; whenTrue: boolean }> = [];
  for (const statement of block.getStatements()) {
    if (statement === child) {
      break;
    }
    if (!Node.isIfStatement(statement) || statement.getElseStatement()) {
      continue;
    }
    if (alwaysReturns(statement.getThenStatement())) {
      guards.push({ condition: statement.getExpression(), whenTrue: false });
    }
  }
  return guards;
}

/** Does this statement leave the function on every path through it? */
function alwaysReturns(statement: TsNode): boolean {
  if (Node.isReturnStatement(statement) || Node.isThrowStatement(statement)) {
    return true;
  }
  if (!Node.isBlock(statement)) {
    return false;
  }
  const statements = statement.getStatements();
  const last = statements[statements.length - 1];
  return last !== undefined && alwaysReturns(last);
}

const COMPARISONS: Record<string, (a: number, b: number) => boolean> = {
  ">": (a, b) => a > b,
  ">=": (a, b) => a >= b,
  "<": (a, b) => a < b,
  "<=": (a, b) => a <= b,
  "===": (a, b) => a === b,
  "==": (a, b) => a === b,
  "!==": (a, b) => a !== b,
  "!=": (a, b) => a !== b,
};

/**
 * A comparison between a bound parameter and a number, evaluated.
 * Null when it is any other shape.
 */
function evaluateComparison(
  condition: TsNode,
  substitutions: ReadonlyMap<string, Expression>,
): boolean | null {
  if (!Node.isBinaryExpression(condition)) {
    return null;
  }

  const left = numberFor(condition.getLeft(), substitutions);
  const right = numberFor(condition.getRight(), substitutions);
  if (left === null || right === null) {
    return null;
  }

  const compare = COMPARISONS[condition.getOperatorToken().getText()];
  return compare === undefined ? null : compare(left, right);
}

function numberFor(
  node: TsNode,
  substitutions: ReadonlyMap<string, Expression>,
): number | null {
  const resolved =
    Node.isIdentifier(node) && substitutions.has(node.getText())
      ? (substitutions.get(node.getText()) as TsNode)
      : node;
  return Node.isNumericLiteral(resolved) ? Number(resolved.getText()) : null;
}

type LocalHelper =
  | {
      kind: "local";
      params: ParameterDeclaration[];
      returnValues: ObjectLiteralExpression[];
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
      const returnValues = returnedObjects(implementation);
      return returnValues.length === 0
        ? { kind: "unreadable" }
        : {
            kind: "local",
            params: implementation.getParameters(),
            returnValues,
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
    const returnValues = returnedObjects(fn);
    if (returnValues.length === 0) {
      return { kind: "unreadable" };
    }
    return { kind: "local", params: fn.getParameters(), returnValues };
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

/** Every object literal a helper returns, in source order. */
function returnedObjects(fn: FunctionLike): ObjectLiteralExpression[] {
  const body = fn.getBody();
  if (body === undefined) {
    return [];
  }

  // Expression-bodied arrow: `(s, p) => ({ statusCode: s, body: p })`.
  // The parentheses are required by the grammar, so unwrap them.
  if (!Node.isBlock(body)) {
    const expression = peelParens(body);
    return Node.isObjectLiteralExpression(expression) ? [expression] : [];
  }

  // Every return in this function, including the ones nested in an `if`.
  // A return inside a callback belongs to the callback, so it is skipped.
  const found: ObjectLiteralExpression[] = [];
  for (const statement of body.getDescendantsOfKind(
    SyntaxKind.ReturnStatement,
  )) {
    if (enclosingFunctionOf(statement) !== body) {
      continue;
    }
    const expression = statement.getExpression();
    if (expression === undefined) {
      continue;
    }
    const unwrapped = peelParens(expression);
    if (Node.isObjectLiteralExpression(unwrapped)) {
      found.push(unwrapped);
    }
  }
  return found;
}

/**
 * The body block a statement belongs to, skipping past any nested
 * function. A `return` inside a callback yields the callback's value,
 * not the helper's, so it does not count as one of the helper's.
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
