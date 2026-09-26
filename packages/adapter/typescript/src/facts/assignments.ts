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
// ordered this way. `valueLeftByWrites` takes the values and that
// answer, and says what the name comes down to.

import { Node, SyntaxKind, VariableDeclarationKind } from "ts-morph";

import { valueLeftByWrites } from "@suss/resolution";

import { createPerFileCache } from "../perFileCache.js";

import type { NameWrite } from "@suss/resolution";
import type {
  BinaryExpression,
  Expression,
  MethodDeclaration,
  ParameterDeclaration,
  PropertyAccessExpression,
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
const byStore = new WeakMap<FieldDeclaration, FieldStore[]>();

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
 * The values a name takes, as `valueLeftByWrites` reads them. Each one
 * is keyed by its place in the list, which is all the answer has to
 * name for the caller to find the node again.
 */
export function describeWrites(values: ReadonlyArray<Node>): NameWrite[] {
  return values.map((value, index) => ({
    value: String(index),
    placeholder: isNotYetPlaceholder(value),
    construction: isConstruction(value) ? sourceOf(value) : null,
    // Which name each value was written to does not reach here, and
    // that is what a narrowing write is compared against.
    narrowsName: false,
  }));
}

/** A `null` or `undefined` literal, which a later write is expected to replace. */
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
 * What one body of a class puts in a field. `method` is null for the
 * constructor, which the field's own initializer runs alongside.
 */
export interface FieldStore {
  method: MethodDeclaration | null;
  /** As `FieldWrites.values`. */
  values: Node[];
  /** As `BindingWrites.inOrder`. */
  inOrder: boolean;
}

/**
 * What each body of the class puts in a field, so the facts can say
 * which function stored what. A write outside the class is left out:
 * nothing here says which object of the class it landed on.
 */
export function storesToField(declaration: FieldDeclaration): FieldStore[] {
  const remembered = byStore.get(declaration);
  if (remembered !== undefined) {
    return remembered;
  }
  const answer = storesToFieldUncached(declaration);
  byStore.set(declaration, answer);
  return answer;
}

function storesToFieldUncached(declaration: FieldDeclaration): FieldStore[] {
  const holder = classHolding(declaration);
  const byBody = new Map<MethodDeclaration | null, Write[]>();
  for (const write of assignmentsTo(declaration)) {
    const body = bodyWriting(write.node, holder);
    if (body === undefined) {
      continue;
    }
    byBody.set(body, [...(byBody.get(body) ?? []), write]);
  }

  const first = startingValueOf(declaration);
  if (first !== undefined && !byBody.has(null)) {
    byBody.set(null, []);
  }

  const stores: FieldStore[] = [];
  for (const [method, writes] of byBody) {
    const store = storeOf(method, method === null ? first : undefined, writes);
    if (store !== null) {
      stores.push(store);
    }
  }
  return stores;
}

/** One body's writes as a store, or null when a write states no value of its own. */
function storeOf(
  method: MethodDeclaration | null,
  first: Node | undefined,
  writes: readonly Write[],
): FieldStore | null {
  const values: Node[] = first === undefined ? [] : [first];
  for (const write of writes) {
    if (write.value === null) {
      return null;
    }
    values.push(write.value);
  }
  return values.length === 0
    ? null
    : {
        method,
        values,
        inOrder: writes.every((write) => runsDirectly(write.node)),
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
  return (
    bodyWriting(write.node, classHolding(declaration)) === null &&
    runsDirectly(write.node)
  );
}

/**
 * The method a write to a field is written in, null for the class's own
 * constructor, and undefined for a write anywhere else. A write inside a
 * callback belongs to the body around the callback.
 */
function bodyWriting(
  node: Node,
  holder: Node | undefined,
): MethodDeclaration | null | undefined {
  for (
    let current = node.getParent();
    current !== undefined;
    current = current.getParent()
  ) {
    if (Node.isConstructorDeclaration(current)) {
      return current.getParent() === holder ? null : undefined;
    }
    if (Node.isMethodDeclaration(current)) {
      return current.getParent() === holder ? current : undefined;
    }
  }
  return undefined;
}

/** Whether a write is a statement of its body's own list, rather than one a branch runs. */
function runsDirectly(node: Node): boolean {
  const body = statementOf(node)?.getParent();
  if (body === undefined || !Node.isBlock(body)) {
    return false;
  }
  const owner = body.getParent();
  return (
    owner !== undefined &&
    (Node.isConstructorDeclaration(owner) || Node.isMethodDeclaration(owner))
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

/**
 * The writes one body makes to a property of a plain name,
 * `client.timeout = 5`, noted by the walk that already visits the body.
 * `owner` is the function or file the body belongs to, and `statements`
 * is the list its own statements are written in.
 */
export interface BodyPropertyWrites {
  owner: Node;
  statements: Node;
  found: BinaryExpression[];
}

/** Notes the node when it writes a property of a plain name. */
export function notePropertyWrite(
  writes: BodyPropertyWrites,
  node: Node,
): void {
  if (
    !Node.isBinaryExpression(node) ||
    !isAssignmentOperator(node.getOperatorToken().getKind())
  ) {
    return;
  }
  const target = node.getLeft();
  if (
    Node.isPropertyAccessExpression(target) &&
    Node.isIdentifier(target.getExpression())
  ) {
    writes.found.push(node);
  }
}

/** A property a body leaves with one value, written through a name. */
export interface NamedStore {
  receiver: Expression;
  property: string;
  value: Expression;
}

/**
 * The value each property written through a name ends up with, for a
 * name the same body declares. A name declared anywhere else is written
 * at a time this body cannot order against its reads, and a parameter
 * leads to no object, so neither is written down. The writes to one
 * property settle the way a reassigned binding's do: they run once each
 * in order with no read of the property before the last, or they build
 * the same value, or they state nothing.
 */
export function namedStoresOf(writes: BodyPropertyWrites): NamedStore[] {
  const byDeclaration = new Map<Node, Map<string, BinaryExpression[]>>();
  for (const write of writes.found) {
    const target = write.getLeft() as PropertyAccessExpression;
    const declaration = declarationHere(target.getExpression(), writes.owner);
    if (declaration === null) {
      continue;
    }
    const byProperty = byDeclaration.get(declaration) ?? new Map();
    byDeclaration.set(declaration, byProperty);
    const property = target.getName();
    byProperty.set(property, [...(byProperty.get(property) ?? []), write]);
  }

  const stores: NamedStore[] = [];
  for (const byProperty of byDeclaration.values()) {
    for (const group of byProperty.values()) {
      const store = settledStore(writes.statements, group);
      if (store !== null) {
        stores.push(store);
      }
    }
  }
  return stores;
}

/** The value one property's writes settle on, or null. */
function settledStore(
  statements: Node,
  group: readonly BinaryExpression[],
): NamedStore | null {
  const last = group[group.length - 1];
  const values: Expression[] = [];
  for (const write of group) {
    if (!writesItsWholeValue(write.getOperatorToken().getKind())) {
      return null;
    }
    values.push(write.getRight());
  }
  // Every write in a group has a property access on its left.
  /* v8 ignore start */
  if (last === undefined) {
    return null;
  }
  /* v8 ignore stop */
  const target = last.getLeft() as PropertyAccessExpression;
  const receiver = target.getExpression();
  const inOrder =
    group.every((write) => statementOf(write)?.getParent() === statements) &&
    !isPropertyReadBefore(
      statements,
      receiver.getText(),
      target.getName(),
      last.getStart(),
    );
  const settled = valueLeftByWrites(describeWrites(values), inOrder);
  const value = settled === null ? undefined : values[Number(settled)];
  return value === undefined
    ? null
    : { receiver, property: target.getName(), value };
}

/** The variable or import a name refers to, when `owner` declares it. */
function declarationHere(name: Node, owner: Node): Node | null {
  const declarations = name.getSymbol()?.getDeclarations() ?? [];
  for (const declaration of declarations) {
    const declaresAValue =
      Node.isVariableDeclaration(declaration) ||
      Node.isImportSpecifier(declaration) ||
      Node.isImportClause(declaration) ||
      Node.isNamespaceImport(declaration);
    if (declaresAValue && bodyOwning(declaration) === owner) {
      return declaration;
    }
  }
  return null;
}

/** The function or file whose body a node is written in. */
function bodyOwning(node: Node): Node {
  for (let at = node.getParent(); at !== undefined; at = at.getParent()) {
    if (Node.isSourceFile(at) || runsAsItsOwnBody(at)) {
      return at;
    }
  }
  return node.getSourceFile();
}

function runsAsItsOwnBody(node: Node): boolean {
  return (
    Node.isFunctionDeclaration(node) ||
    Node.isFunctionExpression(node) ||
    Node.isArrowFunction(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isConstructorDeclaration(node) ||
    Node.isGetAccessorDeclaration(node) ||
    Node.isSetAccessorDeclaration(node)
  );
}

/** Whether the body reads `name.property` anywhere before `position`. */
function isPropertyReadBefore(
  statements: Node,
  name: string,
  property: string,
  position: number,
): boolean {
  let read = false;
  statements.forEachDescendant((node, traversal) => {
    if (read) {
      traversal.stop();
      return;
    }
    if (node.getStart() >= position || startsItsOwnBody(node)) {
      traversal.skip();
      return;
    }
    if (
      Node.isPropertyAccessExpression(node) &&
      node.getName() === property &&
      node.getExpression().getText() === name &&
      !isWriteTarget(node)
    ) {
      read = true;
    }
  });
  return read;
}
