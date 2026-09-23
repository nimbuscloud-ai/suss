/**
 * defaulted.ts: whether a read has something behind it.
 *
 * A read is defaulted when the program still works where the value is
 * missing. Either an `or` supplies a fallback value, or the program
 * tests the value for presence and only uses it where the test passed.
 * The test can be on the read itself or on a local the read initializes
 * inside a function: a truthiness check, a comparison with `None`, or an
 * `in` membership test. The TypeScript and Ruby adapters define the
 * same rule for their own syntax.
 *
 * A read that raises when the value is missing, `os.environ["X"]`, is
 * defaulted only by a test that runs before it.
 */

import { enclosingFunction, field, fields } from "./ast.js";
import { envReadSpellingAt, isEnviron, isSameName } from "./envSpellings.js";
import { readKey } from "./facts/values.js";

import type { EnvReadSpelling } from "./envSpellings.js";
import type { PyNode } from "./parser.js";
import type { Scope } from "./scope.js";

/** An environment read, and the scope the names around it resolve in. */
export interface EnvVariableRead {
  spelling: EnvReadSpelling;
  scope: Scope;
}

/**
 * What a presence test can be about: the variable an environment read
 * looks up, however a test spells its own read or asks `os.environ`; a
 * local the read initializes; or, for any other read, its spelling.
 */
type ReadSubject =
  | { kind: "variable"; read: EnvVariableRead }
  | { kind: "local"; local: Local }
  | { kind: "spelling"; text: string };

/**
 * Whether the program copes with this read coming back empty. Pass
 * `variable` for a read of the environment, so a test that spells the
 * read another way still counts.
 */
export function isDefaultedAt(
  read: PyNode,
  variable?: EnvVariableRead,
): boolean {
  const subject: ReadSubject =
    variable === undefined
      ? { kind: "spelling", text: read.text }
      : { kind: "variable", read: variable };
  if (hasFallbackOperand(read) || isPresentAt(read, subject)) {
    return true;
  }
  if (variable?.spelling.raises === true) {
    return false;
  }
  if (isPresenceTest(read)) {
    return true;
  }
  const local = localNamedBy(read);
  return (
    local !== null &&
    usesOf(local).every((use) => isSafeUse(use, { kind: "local", local }))
  );
}

function isSubject(subject: ReadSubject, expression: PyNode): boolean {
  if (subject.kind === "local") {
    return refersTo(expression, subject.local);
  }
  if (subject.kind === "variable") {
    return readsVariable(expression, subject.read);
  }
  return expression.text === subject.text;
}

function readsVariable(expression: PyNode, read: EnvVariableRead): boolean {
  const other = envReadSpellingAt(expression, read.scope);
  return other !== null && isSameName(other.name, read.spelling.name);
}

/** Only an environment read has a key that `"X" in os.environ` asks about. */
function isKeyOfSubject(
  subject: ReadSubject,
  key: PyNode,
  container: PyNode,
): boolean {
  return (
    subject.kind === "variable" &&
    isEnviron(container, subject.read.scope) &&
    isSameName(key, subject.read.spelling.name)
  );
}

/**
 * Whether an `or` supplies a value when this read comes back empty. The
 * climb continues through a chain, so B in `A or B or "d"` counts, and
 * stops where the read is the final operand and is itself the fallback.
 */
function hasFallbackOperand(node: PyNode): boolean {
  let child = node;
  let parent = node.parent;
  while (parent !== null) {
    if (parent.type === "parenthesized_expression") {
      child = parent;
      parent = parent.parent;
      continue;
    }
    if (
      parent.type !== "boolean_operator" ||
      field(parent, "operator")?.text !== "or"
    ) {
      return false;
    }
    if (field(parent, "left")?.id === child.id) {
      return true;
    }
    child = parent;
    parent = parent.parent;
  }
  return false;
}

/**
 * Whether the value is only tested here and never passed on: `if x:`,
 * `not x`, `x is None`, or a conditional expression's condition. An
 * `and` or `or` operand counts when the whole expression is tested the
 * same way or its result is thrown away.
 */
function isPresenceTest(node: PyNode): boolean {
  let child = climbParens(node);
  let throughLogical = false;
  let parent = child.parent;
  while (parent !== null) {
    if (parent.type === "not_operator") {
      return true;
    }
    if (parent.type === "comparison_operator") {
      return comparedWithNone(parent)?.tested.id === child.id;
    }
    if (parent.type !== "boolean_operator") {
      return (
        conditionOf(parent)?.id === child.id ||
        (throughLogical && parent.type === "expression_statement")
      );
    }
    throughLogical = true;
    child = climbParens(parent);
    parent = child.parent;
  }
  return false;
}

/** The test an `if`, an `elif`, a loop or a conditional expression branches on. */
function conditionOf(node: PyNode): PyNode | null {
  if (node.type === "conditional_expression") {
    return node.namedChildren[1] ?? null;
  }
  return CONDITIONED_TYPES.has(node.type) ? field(node, "condition") : null;
}

const CONDITIONED_TYPES = new Set([
  "if_statement",
  "elif_clause",
  "while_statement",
]);

/**
 * Whether some enclosing test has already passed by the time `node`
 * runs: `node` is in the branch a present value takes, or it follows an
 * `if` that leaves on the absent branch.
 */
function isPresentAt(node: PyNode, subject: ReadSubject): boolean {
  let child = node;
  let parent = node.parent;
  while (parent !== null) {
    if (
      isBranchWherePresent(parent, child, subject) ||
      followsExitWhenAbsent(parent, child, subject)
    ) {
      return true;
    }
    child = parent;
    parent = parent.parent;
  }
  return false;
}

/** Whether `child` is the branch of `parent` that runs only once the subject is present. */
function isBranchWherePresent(
  parent: PyNode,
  child: PyNode,
  subject: ReadSubject,
): boolean {
  if (parent.type === "conditional_expression") {
    const [whenTrue, test, whenFalse] = parent.namedChildren;
    return (
      test !== undefined &&
      test !== null &&
      ((whenTrue?.id === child.id && isPresentWhen(test, true, subject)) ||
        (whenFalse?.id === child.id && isPresentWhen(test, false, subject)))
    );
  }
  if (parent.type === "boolean_operator") {
    const left = field(parent, "left");
    return (
      field(parent, "right")?.id === child.id &&
      left !== null &&
      isPresentWhen(left, field(parent, "operator")?.text === "and", subject)
    );
  }
  const test = conditionOf(parent);
  if (test === null) {
    return false;
  }
  const body =
    parent.type === "while_statement"
      ? field(parent, "body")
      : field(parent, "consequence");
  if (body?.id === child.id) {
    return isPresentWhen(test, true, subject);
  }
  return (
    parent.type === "if_statement" &&
    isAlternativeWherePresent(parent, child, subject)
  );
}

/**
 * An `elif` or `else` runs once the `if` test and every `elif` before
 * it came out false, so any one of them saying present is enough.
 */
function isAlternativeWherePresent(
  statement: PyNode,
  child: PyNode,
  subject: ReadSubject,
): boolean {
  const tests: PyNode[] = [];
  const own = field(statement, "condition");
  if (own !== null) {
    tests.push(own);
  }
  for (const alternative of fields(statement, "alternative")) {
    if (alternative.id === child.id) {
      return tests.some((test) => isPresentWhen(test, false, subject));
    }
    const test = field(alternative, "condition");
    if (test !== null) {
      tests.push(test);
    }
  }
  return false;
}

/**
 * Whether an earlier statement in the same block is an `if` that tests
 * for the missing value and leaves when it is missing. Raising does not
 * count: a program that raises has not coped with the missing value.
 */
function followsExitWhenAbsent(
  parent: PyNode,
  child: PyNode,
  subject: ReadSubject,
): boolean {
  if (parent.type !== "block" && parent.type !== "module") {
    return false;
  }
  const statements = parent.namedChildren;
  const at = statements.findIndex((statement) => statement?.id === child.id);
  return statements
    .slice(0, at)
    .some(
      (statement) => statement !== null && leavesWhenAbsent(statement, subject),
    );
}

function leavesWhenAbsent(statement: PyNode, subject: ReadSubject): boolean {
  const test = field(statement, "condition");
  const body = field(statement, "consequence");
  return (
    statement.type === "if_statement" &&
    test !== null &&
    body !== null &&
    alwaysLeaves(body) &&
    isPresentWhen(test, false, subject)
  );
}

const LEAVING_TYPES = new Set([
  "return_statement",
  "continue_statement",
  "break_statement",
]);

/** A block with a `return`, `continue` or `break` among its own statements. */
function alwaysLeaves(block: PyNode): boolean {
  return block.namedChildren.some(
    (statement) => statement !== null && LEAVING_TYPES.has(statement.type),
  );
}

/**
 * Whether the subject has a value once `test` has come out as `outcome`.
 * Falsy counts as missing, so the empty string takes the branch an unset
 * variable does.
 */
function isPresentWhen(
  test: PyNode,
  outcome: boolean,
  subject: ReadSubject,
): boolean {
  const expression = peelParens(test);
  if (isSubject(subject, expression)) {
    return outcome;
  }
  if (expression.type === "not_operator") {
    const operand = field(expression, "argument");
    return operand !== null && isPresentWhen(operand, !outcome, subject);
  }
  if (expression.type === "boolean_operator") {
    return isPresentAfterLogical(expression, outcome, subject);
  }
  if (expression.type === "comparison_operator") {
    return isPresentAfterComparison(expression, outcome, subject);
  }
  return false;
}

function isPresentAfterLogical(
  expression: PyNode,
  outcome: boolean,
  subject: ReadSubject,
): boolean {
  // `a and b` true says both are true, `a or b` false says both are false.
  if ((field(expression, "operator")?.text === "and") !== outcome) {
    return false;
  }
  return [field(expression, "left"), field(expression, "right")].some(
    (operand) => operand !== null && isPresentWhen(operand, outcome, subject),
  );
}

/** `x is not None`, `x != None`, `"X" in os.environ`, and their opposites. */
function isPresentAfterComparison(
  comparison: PyNode,
  outcome: boolean,
  subject: ReadSubject,
): boolean {
  const parts = comparisonParts(comparison);
  if (parts === null) {
    return false;
  }
  if (parts.operator === "in" || parts.operator === "not in") {
    return (
      outcome === (parts.operator === "in") &&
      isKeyOfSubject(subject, parts.left, parts.right)
    );
  }
  const compared = comparedWithNone(comparison);
  return (
    compared !== null &&
    isSubject(subject, compared.tested) &&
    outcome === compared.saysDifferent
  );
}

/** The two sides of a comparison with one operator, with parentheses peeled. */
function comparisonParts(
  comparison: PyNode,
): { left: PyNode; operator: string; right: PyNode } | null {
  const operators = fields(comparison, "operators");
  const operands = comparison.namedChildren.filter(
    (child): child is PyNode =>
      child !== null && !operators.some((one) => one.id === child.id),
  );
  const [left, right] = operands;
  const operator = operators[0]?.type;
  if (
    operators.length !== 1 ||
    operator === undefined ||
    left === undefined ||
    right === undefined
  ) {
    return null;
  }
  return { left: peelParens(left), operator, right: peelParens(right) };
}

/**
 * The operand a comparison sets against `None` with `is`, `is not`, `==`
 * or `!=`, and whether the comparison is true when the two differ.
 */
function comparedWithNone(
  comparison: PyNode,
): { tested: PyNode; saysDifferent: boolean } | null {
  const parts = comparisonParts(comparison);
  if (parts === null || !NONE_OPERATORS.has(parts.operator)) {
    return null;
  }
  const saysDifferent = parts.operator === "is not" || parts.operator === "!=";
  if (parts.right.type === "none") {
    return { tested: parts.left, saysDifferent };
  }
  return parts.left.type === "none"
    ? { tested: parts.right, saysDifferent }
    : null;
}

const NONE_OPERATORS = new Set(["is", "is not", "==", "!="]);

function peelParens(node: PyNode): PyNode {
  const inner =
    node.type === "parenthesized_expression" ? node.namedChildren[0] : null;
  return inner === null || inner === undefined ? node : peelParens(inner);
}

function climbParens(node: PyNode): PyNode {
  let current = node;
  while (current.parent?.type === "parenthesized_expression") {
    current = current.parent;
  }
  return current;
}

/** A local the read initializes, the function it belongs to, and the key its uses share. */
interface Local {
  name: PyNode;
  scope: PyNode;
  key: string;
}

/**
 * The local `x = <read>` writes, when `x` belongs to the function the
 * assignment is in. A name at module level can be imported elsewhere,
 * where its uses are out of sight.
 */
function localNamedBy(read: PyNode): Local | null {
  const value = climbParens(read);
  const assignment = value.parent;
  if (
    assignment === null ||
    assignment.type !== "assignment" ||
    field(assignment, "right")?.id !== value.id
  ) {
    return null;
  }
  const name = field(assignment, "left");
  const scope = enclosingFunction(assignment);
  if (name === null || name.type !== "identifier" || scope === null) {
    return null;
  }
  const key = bindingKeyOf(name);
  return key === readKey("", name, null) ? null : { name, scope, key };
}

/**
 * The key the value facts give a name where it is written. The file path
 * only prefixes the key, and every key compared here comes from one file.
 */
function bindingKeyOf(name: PyNode): string {
  return readKey("", name, enclosingFunction(name));
}

function refersTo(identifier: PyNode, local: Local): boolean {
  return (
    identifier.type === "identifier" &&
    identifier.text === local.name.text &&
    bindingKeyOf(identifier) === local.key
  );
}

/** Every place the function reads or writes the local, other than the assignment the read is in. */
function usesOf(local: Local): PyNode[] {
  return local.scope
    .descendantsOfType("identifier")
    .filter(
      (identifier): identifier is PyNode =>
        identifier !== null &&
        identifier.id !== local.name.id &&
        !isMemberName(identifier) &&
        refersTo(identifier, local),
    );
}

/** `obj.x` and `f(x=1)` spell `x` without reading a local called `x`. */
function isMemberName(identifier: PyNode): boolean {
  return memberNameIn(identifier.parent)?.id === identifier.id;
}

function memberNameIn(parent: PyNode | null): PyNode | null {
  if (parent?.type === "attribute") {
    return field(parent, "attribute");
  }
  if (parent?.type === "keyword_argument") {
    return field(parent, "name");
  }
  return null;
}

/** Whether a missing value never reaches this use. */
function isSafeUse(use: PyNode, subject: ReadSubject): boolean {
  return (
    hasFallbackOperand(use) || isPresenceTest(use) || isPresentAt(use, subject)
  );
}
