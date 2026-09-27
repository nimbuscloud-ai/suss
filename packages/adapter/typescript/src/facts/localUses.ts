/**
 * The facts about every read of a local that a function builds once, so
 * the shared rules can say whether the value leaves the function.
 *
 * Extraction here is lazy, and a read's surroundings get facts only when
 * some question reaches them. So this walks the function for each
 * reference to the local and states what the expression around it does
 * with the value. The `passedOn` rules in @suss/resolution decide what
 * counts as handing it on. A module-level value is never asked about.
 */

import { Node, SyntaxKind } from "ts-morph";

import { UNPLACED_STORE_NAME } from "@suss/resolution";

import { isFunctionRoot } from "../discovery/shared.js";
import { isWrittenAgain } from "./assignments.js";
import { emitValue, factKeyOf, nodeId, referencedSymbol } from "./extract.js";

import type { Database } from "@suss/datalog";
import type { Expression, VariableDeclaration } from "ts-morph";
import type { NodeTable } from "./extract.js";

function fact(db: Database, relation: string, ...tuple: string[]): void {
  db.add(relation, tuple);
}

/**
 * The declaration behind `receiver` when it is a local that a function
 * declares once and initializes with `construction`, or null.
 */
export function localBuiltOnce(
  receiver: Node,
  construction: Node,
): VariableDeclaration | null {
  if (!Node.isIdentifier(receiver)) {
    return null;
  }
  const declarations = referencedSymbol(receiver)?.getDeclarations() ?? [];
  const [declaration] = declarations;
  if (
    declarations.length !== 1 ||
    declaration === undefined ||
    !Node.isVariableDeclaration(declaration) ||
    !Node.isIdentifier(declaration.getNameNode()) ||
    declaringFunctionOf(declaration) === null ||
    isWrittenAgain(declaration)
  ) {
    return null;
  }
  const initializer = declaration.getInitializer();
  return initializer !== undefined &&
    nodeId(factKeyOf(initializer)) === nodeId(construction)
    ? declaration
    : null;
}

/** The function whose body declares a local, or null at module level. */
function declaringFunctionOf(declaration: Node): Node | null {
  for (
    let at = declaration.getParent();
    at !== undefined;
    at = at.getParent()
  ) {
    if (isFunctionRoot(at) || Node.isConstructorDeclaration(at)) {
      return at;
    }
    if (Node.isSourceFile(at) || Node.isClassDeclaration(at)) {
      return null;
    }
  }
  return null;
}

/**
 * States what each read of the local does with it, and returns the keys
 * to ask the rules about, one per read.
 */
export function emitLocalUses(
  db: Database,
  table: NodeTable,
  declaration: VariableDeclaration,
): string[] {
  const body = declaringFunctionOf(declaration);
  const symbol = referencedSymbol(declaration.getNameNode());
  if (body === null || symbol === undefined) {
    return [];
  }
  const keys: string[] = [];
  body.forEachDescendant((node) => {
    if (
      Node.isIdentifier(node) &&
      node !== declaration.getNameNode() &&
      node.getText() === declaration.getName() &&
      referencedSymbol(node) === symbol
    ) {
      keys.push(emitUse(db, table, operandOf(node)));
    }
  });
  return keys;
}

/** The outermost expression with the same value, through parentheses, `await`, `as`, `satisfies` and `!`. */
function operandOf(node: Node): Expression {
  let current = node as Expression;
  for (;;) {
    const parent = current.getParent();
    if (
      parent !== undefined &&
      (Node.isParenthesizedExpression(parent) ||
        Node.isAwaitExpression(parent) ||
        Node.isAsExpression(parent) ||
        Node.isSatisfiesExpression(parent) ||
        Node.isNonNullExpression(parent) ||
        Node.isTypeAssertion(parent)) &&
      parent.getExpression() === current
    ) {
      current = parent;
      continue;
    }
    return current;
  }
}

/** The facts about one read, and the key they are stated under. */
function emitUse(db: Database, table: NodeTable, operand: Expression): string {
  const key = emitValue(db, table, operand);
  const parent = operand.getParent();
  if (parent !== undefined) {
    CONSUMERS[parent.getKind()]?.(db, table, operand, key, parent);
  }
  return key;
}

type ConsumerReader = (
  db: Database,
  table: NodeTable,
  operand: Expression,
  key: string,
  parent: Node,
) => void;

/**
 * What the expression around a read does with the value. A kind left out
 * hands nothing on, which suits a comparison and not a new spelling.
 */
const CONSUMERS: Partial<Record<SyntaxKind, ConsumerReader>> = {
  [SyntaxKind.PropertyAccessExpression]: emitPartRead,
  [SyntaxKind.ElementAccessExpression]: emitPartRead,
  [SyntaxKind.CallExpression]: emitWhole,
  [SyntaxKind.NewExpression]: emitWhole,
  [SyntaxKind.ArrayLiteralExpression]: emitWhole,
  [SyntaxKind.PropertyAssignment]: emitHolder,
  [SyntaxKind.ShorthandPropertyAssignment]: emitHolder,
  [SyntaxKind.ReturnStatement]: emitEnclosingFunction,
  [SyntaxKind.ArrowFunction]: emitEnclosingFunction,
  [SyntaxKind.Parameter]: emitEnclosingFunction,
  [SyntaxKind.YieldExpression]: emitYield,
  [SyntaxKind.VariableDeclaration]: emitNameWrite,
  [SyntaxKind.BinaryExpression]: emitBinary,
  [SyntaxKind.ConditionalExpression]: emitConditionalBranch,
};

/**
 * `app.router` or `app[key]` hands out a part of the value, which goes
 * wherever the part goes, unless the part is called at once as a method.
 */
function emitPartRead(
  db: Database,
  table: NodeTable,
  operand: Expression,
  _key: string,
  parent: Node,
): void {
  if (
    !(
      Node.isPropertyAccessExpression(parent) ||
      Node.isElementAccessExpression(parent)
    )
  ) {
    return;
  }
  if (parent.getExpression() !== operand) {
    emitValue(db, table, parent);
    return;
  }
  const part = operandOf(parent);
  const around = part.getParent();
  if (
    around !== undefined &&
    (Node.isCallExpression(around) || Node.isNewExpression(around)) &&
    around.getExpression() === part
  ) {
    emitValue(db, table, around);
    return;
  }
  emitUse(db, table, part);
}

/** A call, a construction or an array states how it takes the value when it is emitted. */
function emitWhole(
  db: Database,
  table: NodeTable,
  _operand: Expression,
  _key: string,
  parent: Node,
): void {
  if (Node.isExpression(parent)) {
    emitValue(db, table, parent);
  }
}

/** A property of an object literal, which the literal then contains. */
function emitHolder(
  db: Database,
  table: NodeTable,
  _operand: Expression,
  _key: string,
  parent: Node,
): void {
  const literal = parent.getParent();
  if (literal !== undefined && Node.isObjectLiteralExpression(literal)) {
    emitValue(db, table, literal);
  }
}

/**
 * A return, an arrow's expression body or a parameter's default. The
 * function's own facts say which, as they would for any other question.
 */
function emitEnclosingFunction(
  db: Database,
  table: NodeTable,
  operand: Expression,
  _key: string,
  parent: Node,
): void {
  const fn = Node.isReturnStatement(parent)
    ? enclosingFunctionOf(parent)
    : functionOfParameterOrBody(parent, operand);
  if (fn !== null) {
    emitValue(db, table, fn as Expression);
  }
}

function functionOfParameterOrBody(parent: Node, operand: Node): Node | null {
  if (Node.isArrowFunction(parent)) {
    return parent.getBody() === operand ? parent : null;
  }
  const fn = parent.getParent();
  return fn !== undefined && isFunctionRoot(fn) ? fn : null;
}

function enclosingFunctionOf(node: Node): Node | null {
  for (let at = node.getParent(); at !== undefined; at = at.getParent()) {
    if (isFunctionRoot(at)) {
      return at;
    }
  }
  return null;
}

function emitYield(
  db: Database,
  _table: NodeTable,
  _operand: Expression,
  key: string,
  parent: Node,
): void {
  const fn = enclosingFunctionOf(parent);
  if (fn !== null) {
    fact(db, "yieldsValue", nodeId(fn), key);
  }
}

/**
 * `const served = app` or `served = app` is one write to another name.
 * `mayHold` says that much, and does not settle a name written elsewhere.
 */
function emitNameWrite(
  db: Database,
  _table: NodeTable,
  _operand: Expression,
  key: string,
  parent: Node,
): void {
  const name = Node.isVariableDeclaration(parent)
    ? parent
    : (referencedSymbol(parent)?.getDeclarations()[0] ?? parent);
  fact(db, "mayHold", nodeId(name), key);
}

/** The operators whose write is the whole right side. */
const WHOLE_VALUE_WRITES: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.EqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

/** An assignment of the value, or a fallback with it as a branch. */
function emitBinary(
  db: Database,
  table: NodeTable,
  operand: Expression,
  key: string,
  parent: Node,
): void {
  if (!Node.isBinaryExpression(parent)) {
    return;
  }
  const operator = parent.getOperatorToken().getKind();
  if (
    operator === SyntaxKind.AmpersandAmpersandToken &&
    parent.getRight() === operand
  ) {
    fact(db, "conditionalBranch", nodeId(parent), key);
    return;
  }
  if (!WHOLE_VALUE_WRITES.has(operator)) {
    emitValue(db, table, parent);
    return;
  }
  if (parent.getRight() !== operand) {
    return;
  }
  const target = parent.getLeft();
  if (Node.isPropertyAccessExpression(target)) {
    emitUnplacedStore(db, table, target, key);
    return;
  }
  if (Node.isElementAccessExpression(target)) {
    fact(
      db,
      "holdsUnderKey",
      emitValue(db, table, target.getExpression()),
      key,
    );
    return;
  }
  emitNameWrite(db, table, operand, key, target);
}

/**
 * `holder.app = app`, `globalThis.app = app`, `module.exports = app`. A
 * write the body's settled stores already put on an object stays as it is.
 */
function emitUnplacedStore(
  db: Database,
  table: NodeTable,
  target: Node & { getExpression(): Expression; getName(): string },
  key: string,
): void {
  const object = emitValue(db, table, target.getExpression());
  const property = target.getName();
  const placed = db
    .lookup("storesProperty", 2, key)
    .some((row) => row[0] === object && row[1] === property);
  if (!placed) {
    fact(db, "storesProperty", object, property, key, UNPLACED_STORE_NAME);
  }
}

/** `ready ? app : null`, whose value may be the read. */
function emitConditionalBranch(
  db: Database,
  _table: NodeTable,
  operand: Expression,
  key: string,
  parent: Node,
): void {
  if (
    Node.isConditionalExpression(parent) &&
    parent.getCondition() !== operand
  ) {
    fact(db, "conditionalBranch", nodeId(parent), key);
  }
}
