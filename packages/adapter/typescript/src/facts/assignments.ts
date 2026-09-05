// assignments.ts - the values a variable binding takes, and whether
// the order they take them in is certain.
//
// A `const` takes one value and the declaration says what it is. A
// `let` can be written again later, and then the declaration is one
// write among several. Reading the initializer and stopping there
// reports the first value at full confidence, which is worse than
// reporting nothing.
//
// Which write a read sees is reaching definitions, and answering it in
// general needs control-flow facts nothing in this adapter emits. What
// is answerable without them is the case where control flow cannot
// change the result: every write is directly in the module's own
// statement list, so each runs exactly once in the order it is
// written, and nothing at that level reads the binding before the last
// one. A write inside a branch, a loop, or a function body cannot be
// ordered this way, but it can still be read when every such write is
// the same construction. Short of that, the name resolves to nothing.

import { Node, SyntaxKind, VariableDeclarationKind } from "ts-morph";

import { createPerFileCache } from "../perFileCache.js";

import type {
  Expression,
  ParameterDeclaration,
  PropertyDeclaration,
  SourceFile,
  Statement,
  VariableDeclaration,
} from "ts-morph";

/**
 * A class field, however it is declared. `constructor(private dao: X)`
 * declares one and sets it to the argument, with no field declaration
 * and no assignment written anywhere.
 */
export type FieldDeclaration = PropertyDeclaration | ParameterDeclaration;

/** A name a write can land on: a local binding or a class field. */
type Written = VariableDeclaration | FieldDeclaration;

/** One write to a binding: the value it takes, and where it happens. */
interface Write {
  /**
   * The value assigned, or null when the write's value cannot be read
   * from the assignment alone (`count += 1`, `index++`).
   */
  value: Expression | null;
  node: Node;
}

export interface BindingWrites {
  /** The values the binding takes, in source order. */
  values: Expression[];
  /**
   * Whether each write runs once, in the order it is written, with
   * nothing reading the binding in between. False means the values are
   * candidates the adapter cannot order, and a reader that needs one
   * value has none.
   */
  inOrder: boolean;
}

export interface FieldWrites {
  /**
   * The values the field takes, in the order they run. A parameter
   * property's first value is the parameter itself, which is the only
   * place the value it starts out with is written.
   */
  values: Node[];
  /** As `BindingWrites.inOrder`. */
  inOrder: boolean;
}

const byFile = createPerFileCache<Map<Written, Write[]>>();
const byDeclaration = new WeakMap<VariableDeclaration, BindingWrites>();
const byField = new WeakMap<FieldDeclaration, FieldWrites>();

/**
 * Every value a binding takes, the declaration's initializer first.
 * A binding written once gives that one value and `inOrder`,
 * which is what every `const` and most `let`s are.
 */
export function writesToBinding(
  declaration: VariableDeclaration,
): BindingWrites {
  // Extraction meets the same declaration once per reference to it,
  // and working it out means reading the file around it, so the result
  // is cached.
  const remembered = byDeclaration.get(declaration);
  if (remembered !== undefined) {
    return remembered;
  }
  const answer = writesToBindingUncached(declaration);
  byDeclaration.set(declaration, answer);
  return answer;
}

function writesToBindingUncached(
  declaration: VariableDeclaration,
): BindingWrites {
  const initializer = declaration.getInitializer();
  const assignments = assignmentsTo(declaration);

  if (assignments.length === 0) {
    return {
      values: initializer === undefined ? [] : [initializer],
      inOrder: true,
    };
  }

  const writes = [
    ...(initializer === undefined
      ? []
      : [{ value: initializer, node: declaration }]),
    ...assignments,
  ].sort((left, right) => left.node.getStart() - right.node.getStart());

  const values: Expression[] = [];
  for (const write of writes) {
    if (write.value === null) {
      // A compound assignment's value is written nowhere, so the
      // sequence has a hole and no write can be called the last one.
      return { values: [], inOrder: false };
    }
    values.push(write.value);
  }

  return { values, inOrder: writesRunInOrder(declaration, writes) };
}

/**
 * Whether every write in a set the adapter could not order is the same
 * construction, so the name was assigned that no matter which write
 * ran last. A write of `null` or `undefined` is set aside first: that
 * is a placeholder for "not yet assigned", not a value in its own
 * right, and a name whose writes are only placeholders stays
 * unresolved rather than resolving to one of them.
 *
 * Returns the shared construction, or null when the writes do not
 * agree, or agree on nothing but placeholders.
 */
export function sameConstructionAcrossWrites(
  values: ReadonlyArray<Node>,
): Expression | null {
  const candidates = values.filter((value) => !isNotYetPlaceholder(value));
  if (candidates.length === 0) {
    return null;
  }

  let construction: Expression | null = null;
  for (const value of candidates) {
    if (!isConstruction(value)) {
      return null;
    }
    if (construction !== null && sourceOf(value) !== sourceOf(construction)) {
      return null;
    }
    construction = value;
  }
  return construction;
}

/** A `null` or `undefined` literal, standing in for "not written yet". */
function isNotYetPlaceholder(value: Node): boolean {
  return (
    value.getKind() === SyntaxKind.NullKeyword ||
    (Node.isIdentifier(value) && value.getText() === "undefined")
  );
}

/** A call, a `new`, or an object or array literal: a value built where it is written. */
function isConstruction(value: Node): value is Expression {
  return (
    Node.isCallExpression(value) ||
    Node.isNewExpression(value) ||
    Node.isObjectLiteralExpression(value) ||
    Node.isArrayLiteralExpression(value)
  );
}

/** Source text with whitespace runs collapsed, so formatting alone never tells two constructions apart. */
function sourceOf(node: Node): string {
  return node.getText().replace(/\s+/g, " ").trim();
}

/**
 * What a class field comes down to. The constructor runs once before
 * any method can read a field, so a field the constructor sets and
 * nothing else touches has one value every reader sees. A write in a
 * method, a branch, or a callback runs when something reaches it, and
 * how many times is not a question this reads, so the field comes down
 * to nothing.
 *
 * A field written in two places could be either value, and this
 * reports neither rather than picking one.
 */
export function writesToField(declaration: FieldDeclaration): FieldWrites {
  const remembered = byField.get(declaration);
  if (remembered !== undefined) {
    return remembered;
  }
  const answer = writesToFieldUncached(declaration);
  byField.set(declaration, answer);
  return answer;
}

function writesToFieldUncached(declaration: FieldDeclaration): FieldWrites {
  const first = startingValueOf(declaration);
  const assignments = assignmentsTo(declaration);

  if (assignments.length === 0) {
    return { values: first === undefined ? [] : [first], inOrder: true };
  }

  const values: Node[] = [];
  for (const write of assignments) {
    if (write.value === null) {
      return { values: [], inOrder: false };
    }
    values.push(write.value);
  }

  return {
    values: first === undefined ? values : [first, ...values],
    inOrder: assignments.every((write) =>
      writeRunsInConstructor(declaration, write),
    ),
  };
}

/**
 * The value a field has before anything assigns to it. A parameter
 * property's is the parameter, which the language sets the field to
 * before the constructor's first statement runs.
 */
function startingValueOf(declaration: FieldDeclaration): Node | undefined {
  return Node.isParameterDeclaration(declaration)
    ? declaration
    : declaration.getInitializer();
}

/**
 * Whether a write is a statement of the class's own constructor. A
 * write anywhere else runs at a time the reader cannot know, and a
 * write in another class's constructor is about another field of the
 * same name.
 */
function writeRunsInConstructor(
  declaration: FieldDeclaration,
  write: Write,
): boolean {
  const statement = statementOf(write.node);
  if (statement === null) {
    return false;
  }
  const body = statement.getParent();
  if (body === undefined || !Node.isBlock(body)) {
    return false;
  }
  const owner = body.getParent();
  return (
    owner !== undefined &&
    Node.isConstructorDeclaration(owner) &&
    owner.getParent() === classHolding(declaration)
  );
}

/** The class a field belongs to. */
function classHolding(declaration: FieldDeclaration): Node | undefined {
  return Node.isParameterDeclaration(declaration)
    ? declaration.getParent().getParent()
    : declaration.getParent();
}

/** Whether a binding takes a second value somewhere after its declaration. */
export function isWrittenAgain(declaration: VariableDeclaration): boolean {
  return assignmentsTo(declaration).length > 0;
}

function assignmentsTo(declaration: Written): Write[] {
  if (
    Node.isPropertyDeclaration(declaration) ||
    Node.isParameterDeclaration(declaration)
  ) {
    const sourceFile = declaration.getSourceFile();
    return sourceFile.isDeclarationFile()
      ? []
      : (assignmentsInFile(sourceFile).get(declaration) ?? []);
  }
  // A `const` cannot be written again, and nearly every binding a pack
  // asks about is one, so answering from the declaration keyword keeps
  // the file walk off the common path entirely.
  if (
    declaration.getVariableStatement()?.getDeclarationKind() ===
    VariableDeclarationKind.Const
  ) {
    return [];
  }
  const sourceFile = declaration.getSourceFile();
  // `declare var console` and everything else a types file states has
  // no assignment to find, and those files are the largest anything
  // here would walk: the DOM library alone dwarfs a project file.
  if (sourceFile.isDeclarationFile()) {
    return [];
  }
  return assignmentsInFile(sourceFile).get(declaration) ?? [];
}

/**
 * Every assignment in a file, grouped by the declaration it writes to.
 * Built once per file: the walk costs what one of the walks extraction
 * already makes costs, and a file where nothing is reassigned ends up
 * with an empty map.
 */
function assignmentsInFile(sourceFile: SourceFile): Map<Written, Write[]> {
  const cached = byFile.get(sourceFile);
  if (cached !== undefined) {
    return cached;
  }

  const found = new Map<Written, Write[]>();
  byFile.set(sourceFile, found);

  sourceFile.forEachDescendant((node) => {
    const written = writeAt(node);
    if (written === null) {
      return;
    }
    for (const declaration of declarationsOf(written.target)) {
      const writes = found.get(declaration);
      if (writes === undefined) {
        found.set(declaration, [written.write]);
      } else {
        writes.push(written.write);
      }
    }
  });
  return found;
}

/** Whether a token is `=` or one of the compound assignments. */
function isAssignmentOperator(kind: SyntaxKind): boolean {
  return (
    kind >= SyntaxKind.FirstAssignment && kind <= SyntaxKind.LastAssignment
  );
}

/**
 * `??=` and `||=` only run when the left side is nullish or falsy, but
 * the value they assign when they do run is the whole right side, the
 * same as a plain `=`. `+=` and the rest combine the right side with
 * whatever is already there, so their value is not written anywhere.
 */
function writesItsWholeValue(kind: SyntaxKind): boolean {
  return (
    kind === SyntaxKind.EqualsToken ||
    kind === SyntaxKind.QuestionQuestionEqualsToken ||
    kind === SyntaxKind.BarBarEqualsToken
  );
}

/** The write a node performs on a name, when it performs one. */
function writeAt(node: Node): { target: Node; write: Write } | null {
  if (Node.isBinaryExpression(node)) {
    const operator = node.getOperatorToken().getKind();
    const target = node.getLeft();
    if (
      !isAssignmentOperator(operator) ||
      !(Node.isIdentifier(target) || Node.isPropertyAccessExpression(target))
    ) {
      return null;
    }
    const value = writesItsWholeValue(operator) ? node.getRight() : null;
    return { target, write: { value, node } };
  }

  if (
    Node.isPrefixUnaryExpression(node) ||
    Node.isPostfixUnaryExpression(node)
  ) {
    const operator = node.getOperatorToken();
    if (
      operator !== SyntaxKind.PlusPlusToken &&
      operator !== SyntaxKind.MinusMinusToken
    ) {
      return null;
    }
    const target = node.getOperand();
    return Node.isIdentifier(target)
      ? { target, write: { value: null, node } }
      : null;
  }

  return null;
}

function declarationsOf(name: Node): Written[] {
  // `this.tableName = x` writes to the field the name refers to, and
  // the name is where the symbol is.
  const nameNode = Node.isPropertyAccessExpression(name)
    ? name.getNameNode()
    : name;
  const symbol = nameNode.getSymbol();
  if (symbol === undefined) {
    return [];
  }
  const declarations: Written[] = [];
  for (const declaration of symbol.getDeclarations()) {
    if (
      Node.isVariableDeclaration(declaration) ||
      Node.isPropertyDeclaration(declaration) ||
      // A parameter property is the field's only declaration, so
      // `this.dao = other` in the constructor writes to it.
      (Node.isParameterDeclaration(declaration) &&
        declaration.isParameterProperty())
    ) {
      declarations.push(declaration);
    }
  }
  return declarations;
}

/**
 * Whether the writes run once each, in the order they are written.
 *
 * They do when every one of them is a statement of the module itself.
 * A module's top-level statements run through once, top to bottom;
 * they cannot repeat, and nothing skips one. A write anywhere else
 * runs when something calls or enters the construct it is inside, and
 * how many times is not a question this reads.
 *
 * The last write also has to be the one every read sees, so a read
 * between the declaration and it makes the result depend on
 * where the reader is, which the rules have no way to express.
 */
function writesRunInOrder(
  declaration: VariableDeclaration,
  writes: Write[],
): boolean {
  const sourceFile = declaration.getSourceFile();

  for (const write of writes) {
    const statement = statementOf(write.node);
    if (statement === null || statement.getParent() !== sourceFile) {
      return false;
    }
  }

  const last = writes[writes.length - 1];
  return last !== undefined && !isReadBefore(declaration, last.node.getStart());
}

function statementOf(node: Node): Statement | null {
  let current: Node | undefined = node;
  while (current !== undefined) {
    if (Node.isStatement(current)) {
      return current;
    }
    current = current.getParent();
  }
  return null;
}

/**
 * Whether a module statement before `position` reads the binding.
 * A reference inside a function body is not a read yet: the body runs
 * when something calls it, which for a module's exports is after the
 * module has finished.
 */
function isReadBefore(
  declaration: VariableDeclaration,
  position: number,
): boolean {
  const name = declaration.getName();
  const sourceFile = declaration.getSourceFile();

  let read = false;
  sourceFile.forEachDescendant((node, traversal) => {
    if (read) {
      traversal.stop();
      return;
    }
    if (node.getStart() >= position) {
      traversal.skip();
      return;
    }
    if (startsItsOwnBody(node)) {
      traversal.skip();
      return;
    }
    if (!Node.isIdentifier(node) || node.getText() !== name) {
      return;
    }
    if (node === declaration.getNameNode() || isWriteTarget(node)) {
      return;
    }
    if (declarationsOf(node).includes(declaration)) {
      read = true;
    }
  });
  return read;
}

function startsItsOwnBody(node: Node): boolean {
  return (
    Node.isFunctionDeclaration(node) ||
    Node.isFunctionExpression(node) ||
    Node.isArrowFunction(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isClassDeclaration(node)
  );
}

/** Whether a name occurrence is the target of an assignment to it. */
function isWriteTarget(name: Node): boolean {
  const parent = name.getParent();
  if (parent === undefined) {
    return false;
  }
  if (Node.isBinaryExpression(parent)) {
    return (
      parent.getLeft() === name &&
      isAssignmentOperator(parent.getOperatorToken().getKind())
    );
  }
  return (
    (Node.isPrefixUnaryExpression(parent) ||
      Node.isPostfixUnaryExpression(parent)) &&
    parent.getOperand() === name
  );
}
