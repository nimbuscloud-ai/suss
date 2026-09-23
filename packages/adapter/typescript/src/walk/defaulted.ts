/**
 * defaulted.ts: whether a read has something behind it.
 *
 * A read is defaulted when the program still works where the value is
 * missing. Either a `??` or `||` supplies a fallback value, or the
 * program tests the value for presence and only uses it where the test
 * passed. The test can be on the read itself or on a local the read
 * initializes: a truthiness check, a comparison with `undefined` or
 * `null`, or an `in` membership test.
 *
 * All of this is ECMAScript, so the packs that record a read ask here
 * instead of each spelling the forms out. The Python and Ruby adapters
 * define the same rule for their own syntax.
 */

import { Node, SyntaxKind } from "ts-morph";

import { findEnclosingFunction } from "../discovery/shared.js";
import { symbolBehind } from "../resolve/functionBehind.js";
import { climbSyntax, peelSyntax } from "./unwrap.js";

import type {
  BinaryExpression,
  BindingElement,
  ElementAccessExpression,
  Identifier,
  PropertyAccessExpression,
  Statement,
  Symbol as TsSymbol,
  VariableDeclaration,
} from "ts-morph";
import type { FunctionRoot } from "../conditions.js";

/**
 * What a presence test can be about: the read itself, which a test
 * spells the same way or asks about with `"X" in obj`, or a local the
 * read initializes.
 */
type Subject =
  | { kind: "read"; read: Node; text: string }
  | { kind: "local"; local: Local };

/** A local the read initializes, and the function it is visible in. */
interface Local {
  name: Identifier;
  symbol: TsSymbol;
  scope: FunctionRoot;
}

/**
 * Whether the program copes with this read coming back empty: something
 * falls back from it, or every use of its value runs only after a
 * presence test has passed.
 */
export function isDefaultedAt(node: Node): boolean {
  if (!Node.isBindingElement(node)) {
    const read = climbSyntax(node);
    const inner = peelSyntax(read);
    const subject: Subject = {
      kind: "read",
      read: inner,
      text: inner.getText(),
    };
    if (isSafeUse(read, subject)) {
      return true;
    }
  }
  const local = localNamedBy(node);
  return (
    local !== null &&
    usesOf(local).every((use) => isSafeUse(use, { kind: "local", local }))
  );
}

/**
 * A test is about the read when it spells the same expression, so
 * `process.env.X` in the condition guards `process.env.X` in the branch.
 * A test is about a local when it refers to the same binding.
 */
function isSubject(subject: Subject, expression: Node): boolean {
  if (subject.kind === "local") {
    return Node.isIdentifier(expression) && refersTo(expression, subject.local);
  }
  return expression.getText() === subject.text;
}

/** `"X" in process.env` asks about `process.env.X` and `process.env["X"]`. */
function isKeyOfSubject(subject: Subject, key: Node, container: Node): boolean {
  return subject.kind === "read" && isKeyOfRead(subject.read, key, container);
}

/** Whether a missing value never reaches this use. */
function isSafeUse(use: Node, subject: Subject): boolean {
  return (
    hasFallbackOperand(use) || isPresenceTest(use) || isPresentAt(use, subject)
  );
}

/**
 * `env.X ?? "default"` and `env.X || other` both supply a value, and so
 * does the middle of a chain: in `env.A || env.B || undefined`, B's
 * fallback is the chain's tail. The climb stops when the read is the
 * final operand (`getDefault() ?? env.X`), where the read is itself the
 * fallback and its absence propagates.
 */
function hasFallbackOperand(node: Node): boolean {
  let child = climbSyntax(node);
  let parent = child.getParent();
  while (parent !== undefined) {
    if (!Node.isBinaryExpression(parent)) {
      return false;
    }
    // The token text rather than the SyntaxKind enum, which renumbers
    // between TypeScript releases.
    const operator = parent.getOperatorToken().getText();
    if (operator !== "??" && operator !== "||") {
      return false;
    }
    if (parent.getLeft() === child) {
      return true;
    }
    child = climbSyntax(parent);
    parent = child.getParent();
  }
  return false;
}

/**
 * Whether the value is only tested here and never passed on:
 * `if (env.X)`, `!env.X`, `env.X === undefined`, or a ternary's
 * condition. An `&&` or `||` operand counts when the whole expression
 * is tested the same way or its result is thrown away.
 */
function isPresenceTest(node: Node): boolean {
  let child = climbSyntax(node);
  let throughLogical = false;
  let parent = child.getParent();
  while (parent !== undefined) {
    if (negatedOperand(parent) !== null || Node.isTypeOfExpression(parent)) {
      return true;
    }
    if (!Node.isBinaryExpression(parent)) {
      return (
        conditionOf(parent) === child ||
        (throughLogical && Node.isExpressionStatement(parent))
      );
    }
    const operator = parent.getOperatorToken().getText();
    if (EQUALITY_OPERATORS.has(operator)) {
      return missingSideOf(parent) === peelSyntax(child);
    }
    if (operator !== "&&" && operator !== "||") {
      return false;
    }
    throughLogical = true;
    child = climbSyntax(parent);
    parent = child.getParent();
  }
  return false;
}

/** The test an `if`, a loop or a ternary branches on. */
function conditionOf(node: Node): Node | undefined {
  if (
    Node.isIfStatement(node) ||
    Node.isWhileStatement(node) ||
    Node.isDoStatement(node)
  ) {
    return node.getExpression();
  }
  if (Node.isConditionalExpression(node) || Node.isForStatement(node)) {
    return node.getCondition();
  }
  return undefined;
}

/**
 * Whether some enclosing test has already passed by the time `node`
 * runs: `node` is in the branch a present value takes, or it follows an
 * `if` that leaves on the absent branch.
 */
function isPresentAt(node: Node, subject: Subject): boolean {
  let child = node;
  let parent = child.getParent();
  while (parent !== undefined) {
    if (
      isBranchWherePresent(parent, child, subject) ||
      followsExitWhenAbsent(parent, child, subject)
    ) {
      return true;
    }
    child = parent;
    parent = child.getParent();
  }
  return false;
}

/** Whether `child` is the branch of `parent` that runs only once the subject is present. */
function isBranchWherePresent(
  parent: Node,
  child: Node,
  subject: Subject,
): boolean {
  if (Node.isIfStatement(parent)) {
    return isBranchTaken(parent.getExpression(), child, subject, {
      whenTrue: parent.getThenStatement(),
      whenFalse: parent.getElseStatement(),
    });
  }
  if (Node.isConditionalExpression(parent)) {
    return isBranchTaken(parent.getCondition(), child, subject, {
      whenTrue: parent.getWhenTrue(),
      whenFalse: parent.getWhenFalse(),
    });
  }
  if (Node.isWhileStatement(parent)) {
    return isBranchTaken(parent.getExpression(), child, subject, {
      whenTrue: parent.getStatement(),
    });
  }
  if (!Node.isBinaryExpression(parent) || parent.getRight() !== child) {
    return false;
  }
  const operator = parent.getOperatorToken().getText();
  return (
    (operator === "&&" || operator === "||") &&
    isPresentWhen(parent.getLeft(), operator === "&&", subject)
  );
}

function isBranchTaken(
  test: Node,
  child: Node,
  subject: Subject,
  branches: { whenTrue: Node; whenFalse?: Node | undefined },
): boolean {
  if (child === branches.whenTrue) {
    return isPresentWhen(test, true, subject);
  }
  return child === branches.whenFalse && isPresentWhen(test, false, subject);
}

/**
 * Whether an earlier statement in the same block is an `if` that tests
 * for the missing value and leaves when it is missing. Throwing does not
 * count: a program that throws has not coped with the missing value.
 */
function followsExitWhenAbsent(
  parent: Node,
  child: Node,
  subject: Subject,
): boolean {
  if (!(Node.isBlock(parent) || Node.isSourceFile(parent))) {
    return false;
  }
  const statements = parent.getStatements();
  return statements
    .slice(0, statements.indexOf(child as Statement))
    .some(
      (statement) =>
        Node.isIfStatement(statement) &&
        alwaysLeaves(statement.getThenStatement()) &&
        isPresentWhen(statement.getExpression(), false, subject),
    );
}

/** A `return`, `continue` or `break`, alone or among a block's own statements. */
function alwaysLeaves(statement: Node): boolean {
  if (Node.isBlock(statement)) {
    return statement.getStatements().some(alwaysLeaves);
  }
  return (
    Node.isReturnStatement(statement) ||
    Node.isContinueStatement(statement) ||
    Node.isBreakStatement(statement)
  );
}

/**
 * Whether the subject has a value once `test` has come out as `outcome`.
 * Falsy counts as missing, so the empty string takes the branch an unset
 * variable does.
 */
function isPresentWhen(
  test: Node,
  outcome: boolean,
  subject: Subject,
): boolean {
  const expression = peelSyntax(test);
  if (isSubject(subject, expression)) {
    return outcome;
  }
  const negated = negatedOperand(expression);
  if (negated !== null) {
    return isPresentWhen(negated, !outcome, subject);
  }
  if (!Node.isBinaryExpression(expression)) {
    return false;
  }
  const operator = expression.getOperatorToken().getText();
  const left = expression.getLeft();
  const right = expression.getRight();
  if (operator === "&&") {
    return (
      outcome &&
      (isPresentWhen(left, true, subject) ||
        isPresentWhen(right, true, subject))
    );
  }
  if (operator === "||") {
    return (
      !outcome &&
      (isPresentWhen(left, false, subject) ||
        isPresentWhen(right, false, subject))
    );
  }
  if (operator === "in") {
    return (
      outcome && isKeyOfSubject(subject, peelSyntax(left), peelSyntax(right))
    );
  }
  if (!EQUALITY_OPERATORS.has(operator)) {
    return false;
  }
  const tested = missingSideOf(expression);
  const saysDifferent = operator === "!==" || operator === "!=";
  return (
    tested !== null && isSubject(subject, tested) && outcome === saysDifferent
  );
}

const EQUALITY_OPERATORS = new Set(["===", "==", "!==", "!="]);

/**
 * The operand an equality compares with missing: `x !== undefined`,
 * `x != null`, `typeof x !== "undefined"`, either way round. A strict
 * comparison with `null` says nothing about `undefined`, so it has none.
 */
function missingSideOf(comparison: BinaryExpression): Node | null {
  const operator = comparison.getOperatorToken().getText();
  const loose = operator === "==" || operator === "!=";
  const left = peelSyntax(comparison.getLeft());
  const right = peelSyntax(comparison.getRight());
  return comparedValue(left, right, loose) ?? comparedValue(right, left, loose);
}

function comparedValue(
  operand: Node,
  other: Node,
  loose: boolean,
): Node | null {
  if (Node.isTypeOfExpression(operand)) {
    return Node.isStringLiteral(other) &&
      other.getLiteralValue() === "undefined"
      ? peelSyntax(operand.getExpression())
      : null;
  }
  const missing =
    (Node.isIdentifier(other) && other.getText() === "undefined") ||
    (loose && Node.isNullLiteral(other));
  return missing ? operand : null;
}

/** The operand of a `!`, or null for anything else. */
function negatedOperand(node: Node): Node | null {
  if (
    Node.isPrefixUnaryExpression(node) &&
    node.getOperatorToken() === SyntaxKind.ExclamationToken
  ) {
    return node.getOperand();
  }
  return null;
}

function isKeyOfRead(read: Node, key: Node, container: Node): boolean {
  return (
    (Node.isPropertyAccessExpression(read) ||
      Node.isElementAccessExpression(read)) &&
    read.getExpression().getText() === container.getText() &&
    isKeyReadBy(read, key)
  );
}

function isKeyReadBy(
  read: PropertyAccessExpression | ElementAccessExpression,
  key: Node,
): boolean {
  if (Node.isPropertyAccessExpression(read)) {
    return (
      Node.isStringLiteral(key) && key.getLiteralValue() === read.getName()
    );
  }
  return read.getArgumentExpression()?.getText() === key.getText();
}

/** Whether an identifier refers to the local, which the checker settles. */
function refersTo(identifier: Identifier, local: Local): boolean {
  return (
    identifier.getText() === local.name.getText() &&
    symbolBehind(identifier) === local.symbol
  );
}

/**
 * The local this read initializes inside a function: `const v = env.X`,
 * or `const { X } = env` for a binding element. A name at module level
 * can be imported elsewhere, where its uses are out of sight.
 */
function localNamedBy(node: Node): Local | null {
  const declaration = declarationInitializedBy(node);
  if (declaration === null) {
    return null;
  }
  const name = declaration.getNameNode();
  const scope = findEnclosingFunction(declaration);
  if (!Node.isIdentifier(name) || scope === null) {
    return null;
  }
  const symbol = symbolBehind(name);
  return symbol === undefined ? null : { name, symbol, scope };
}

function declarationInitializedBy(
  node: Node,
): VariableDeclaration | BindingElement | null {
  if (Node.isBindingElement(node)) {
    return node;
  }
  const read = climbSyntax(node);
  const parent = read.getParent();
  if (
    parent !== undefined &&
    Node.isVariableDeclaration(parent) &&
    parent.getInitializer() === read
  ) {
    return parent;
  }
  return null;
}

/** Every place the function reads or writes the local, other than where it is declared. */
function usesOf(local: Local): Identifier[] {
  return local.scope
    .getDescendantsOfKind(SyntaxKind.Identifier)
    .filter(
      (identifier) => identifier !== local.name && refersTo(identifier, local),
    );
}
