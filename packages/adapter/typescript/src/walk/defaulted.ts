/**
 * defaulted.ts: whether a read has something behind it.
 *
 * A read is defaulted when the program still works where the value is
 * missing. Either a `??` or `||` supplies a fallback value, or the
 * program tests the value for presence, only uses it where the test
 * passed, and the path a missing value takes does not end in a throw.
 * The test can be on the read itself or on a local the read
 * initializes: a truthiness check, a comparison with `undefined` or
 * `null`, or an `in` membership test.
 *
 * All of this is ECMAScript, so the packs that record a read ask here
 * instead of each spelling the forms out. The Python and Ruby adapters
 * define the same rule for their own syntax.
 */

import { Node, SyntaxKind } from "ts-morph";

import { findEnclosingFunction, isFunctionRoot } from "../discovery/shared.js";
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
    hasFallbackOperand(use) ||
    isPresenceTest(use, subject) ||
    isPresentAt(use, subject)
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
 * is tested the same way or its result is thrown away. A test that
 * branches counts only when the path a missing value takes does not
 * throw, so `if (!env.X) throw ...` leaves the read required.
 */
function isPresenceTest(node: Node, subject: Subject): boolean {
  let child = climbSyntax(node);
  let tested = false;
  let throughLogical = false;
  let parent = child.getParent();
  while (parent !== undefined) {
    if (!Node.isBinaryExpression(parent)) {
      if (negatedOperand(parent) === null && !Node.isTypeOfExpression(parent)) {
        return isTestedAt(parent, child, subject, { tested, throughLogical });
      }
      tested = true;
    } else {
      const step = logicalStep(parent, child);
      if (step === null) {
        return false;
      }
      tested ||= step === "tested";
      throughLogical ||= step === "logical";
    }
    child = climbSyntax(parent);
    parent = child.getParent();
  }
  return false;
}

/**
 * What a binary expression does with an operand that is the value: a
 * comparison with missing turns it into a test, `&&` and `||` pass it on,
 * and anything else uses it.
 */
function logicalStep(
  parent: BinaryExpression,
  child: Node,
): "tested" | "logical" | null {
  const operator = parent.getOperatorToken().getText();
  if (operator === "&&" || operator === "||") {
    return "logical";
  }
  if (!EQUALITY_OPERATORS.has(operator)) {
    return null;
  }
  const operand = peelSyntax(child);
  // `typeof x === "string"` is false for a missing value as surely as a
  // comparison with "undefined" is true for one.
  return Node.isTypeOfExpression(operand) || missingSideOf(parent) === operand
    ? "tested"
    : null;
}

/** Where a test's value ends up: the condition of a branch, a statement of its own, or a boolean kept for later. */
function isTestedAt(
  parent: Node,
  child: Node,
  subject: Subject,
  seen: { tested: boolean; throughLogical: boolean },
): boolean {
  if (conditionOf(parent) === child) {
    return !absentPathThrows(parent, subject);
  }
  if (seen.throughLogical && Node.isExpressionStatement(parent)) {
    return !continuationThrows(parent);
  }
  return seen.tested;
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
      (isBranchWherePresent(parent, child, subject) &&
        !absentPathThrows(parent, subject)) ||
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
        exitOf(statement.getThenStatement()) === "leave" &&
        isPresentWhen(statement.getExpression(), false, subject),
    );
}

/**
 * Whether a missing value can end in a throw once it reaches this
 * branch point. For an `if`, that is any branch a missing value can take
 * which throws, or falls through to a throw after the `if`. For a
 * ternary, a loop or `&&`, it is what runs after the whole expression.
 */
function absentPathThrows(owner: Node, subject: Subject): boolean {
  if (!Node.isIfStatement(owner)) {
    return continuationThrows(owner);
  }
  const test = owner.getExpression();
  const arms: (Node | undefined)[] = [];
  if (!isPresentWhen(test, true, subject)) {
    arms.push(owner.getThenStatement());
  }
  if (!isPresentWhen(test, false, subject)) {
    arms.push(owner.getElseStatement());
  }
  return arms.some((arm) => armThrows(arm, owner, subject));
}

/** Whether one branch of an `if` throws, itself or in what runs after the `if`. */
function armThrows(
  arm: Node | undefined,
  owner: Node,
  subject: Subject,
): boolean {
  if (arm !== undefined && Node.isIfStatement(arm)) {
    return absentPathThrows(arm, subject);
  }
  const exit = arm === undefined ? null : exitOf(arm);
  return exit === "throw" || (exit === null && continuationThrows(owner));
}

/**
 * Whether the statements that run after this node, up to the end of the
 * function, reach a `throw` before a `return`, `continue` or `break`.
 * A loop body that falls off its end goes round again, so the climb
 * stops at a loop as it does at a function.
 */
function continuationThrows(from: Node): boolean {
  let current = from;
  let parent = current.getParent();
  while (parent !== undefined) {
    if (Node.isBlock(parent) || Node.isSourceFile(parent)) {
      const statements = parent.getStatements();
      const after = statements.slice(
        statements.indexOf(current as Statement) + 1,
      );
      const exit = firstExit(after);
      if (exit !== null) {
        return exit === "throw";
      }
    }
    if (endsThePath(parent)) {
      return false;
    }
    current = parent;
    parent = current.getParent();
  }
  return false;
}

function endsThePath(node: Node): boolean {
  return (
    isFunctionRoot(node) ||
    Node.isIterationStatement(node) ||
    Node.isReturnStatement(node)
  );
}

type Exit = "throw" | "leave";

/** How the first of these statements that ends the path ends it, or null when they all fall through. */
function firstExit(statements: readonly Node[]): Exit | null {
  for (const statement of statements) {
    const exit = exitOf(statement);
    if (exit !== null) {
      return exit;
    }
  }
  return null;
}

/** A `throw`, or a `return`, `continue` or `break`, alone or among a block's own statements. */
function exitOf(statement: Node): Exit | null {
  if (Node.isThrowStatement(statement)) {
    return "throw";
  }
  if (
    Node.isReturnStatement(statement) ||
    Node.isContinueStatement(statement) ||
    Node.isBreakStatement(statement)
  ) {
    return "leave";
  }
  return Node.isBlock(statement) ? firstExit(statement.getStatements()) : null;
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
