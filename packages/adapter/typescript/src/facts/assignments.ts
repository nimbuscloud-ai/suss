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
// one. Anywhere else, a write inside a branch, a loop, or a function
// body, this cannot decide and says so, and the name resolves to
// nothing.

import { Node, SyntaxKind, VariableDeclarationKind } from "ts-morph";

import { createPerFileCache } from "../perFileCache.js";

import type {
  Expression,
  PropertyDeclaration,
  SourceFile,
  Statement,
  VariableDeclaration,
} from "ts-morph";

/** A name a write can land on: a local binding or a class field. */
type Written = VariableDeclaration | PropertyDeclaration;

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

const byFile = createPerFileCache<Map<Written, Write[]>>();
const byDeclaration = new WeakMap<Written, BindingWrites>();

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
 * What a class field comes down to. The constructor runs once before
 * any method can read a field, so a field the constructor sets and
 * nothing else touches has one value every reader sees. A write in a
 * method, a branch, or a callback runs when something reaches it, and
 * how many times is not a question this reads, so the field comes down
 * to nothing.
 */
export function writesToField(declaration: PropertyDeclaration): BindingWrites {
  const remembered = byDeclaration.get(declaration);
  if (remembered !== undefined) {
    return remembered;
  }
  const answer = writesToFieldUncached(declaration);
  byDeclaration.set(declaration, answer);
  return answer;
}

function writesToFieldUncached(
  declaration: PropertyDeclaration,
): BindingWrites {
  const initializer = declaration.getInitializer();
  const assignments = assignmentsTo(declaration);

  if (assignments.length === 0) {
    return {
      values: initializer === undefined ? [] : [initializer],
      inOrder: true,
    };
  }

  const values: Expression[] = [];
  for (const write of assignments) {
    if (write.value === null) {
      return { values: [], inOrder: false };
    }
    values.push(write.value);
  }
  const withInitializer =
    initializer === undefined ? values : [initializer, ...values];

  return {
    values: withInitializer,
    inOrder: assignments.every((write) =>
      writeRunsInConstructor(declaration, write),
    ),
  };
}

/**
 * Whether a write is a statement of the class's own constructor. A
 * write anywhere else runs at a time the reader cannot know, and a
 * write in another class's constructor is about another field of the
 * same name.
 */
function writeRunsInConstructor(
  declaration: PropertyDeclaration,
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
    owner.getParent() === declaration.getParent()
  );
}

/** Whether a binding takes a second value somewhere after its declaration. */
export function isWrittenAgain(declaration: VariableDeclaration): boolean {
  return assignmentsTo(declaration).length > 0;
}

function assignmentsTo(declaration: Written): Write[] {
  if (Node.isPropertyDeclaration(declaration)) {
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
    const value = operator === SyntaxKind.EqualsToken ? node.getRight() : null;
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
      Node.isPropertyDeclaration(declaration)
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
