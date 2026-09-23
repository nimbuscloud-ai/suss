/**
 * defaulted.ts: whether a read has something behind it.
 *
 * A read is defaulted when the program still works where the value is
 * missing. Either an `||` supplies a fallback value, or the program
 * tests the value for presence and only uses it where the test passed.
 * The test can be on the read itself or on a local the read initializes
 * inside a method: a truthiness check, `nil?` or a comparison with
 * `nil`, or a membership test such as `ENV.key?`. The TypeScript and
 * Python adapters define the same rule for their own syntax.
 *
 * A read that raises when the value is missing, `ENV.fetch("X")`, is
 * defaulted only by a test that runs before it.
 */

import { enclosingDefinition, field, readCallArgs } from "./ast.js";
import { envSpellingAt, isEnv, isSameName } from "./envSpellings.js";
import { ownerOfName } from "./facts/locals.js";
import { readKey } from "./facts/values.js";

import type { EnvSpelling } from "./envSpellings.js";
import type { RbNode } from "./parser.js";

/**
 * What a presence test can be about: the variable an environment read
 * looks up, however a test spells its own read or asks `ENV`; a local
 * the read initializes; or, for any other read, its spelling.
 */
type ReadSubject =
  | { kind: "variable"; spelling: EnvSpelling }
  | { kind: "local"; local: Local }
  | { kind: "spelling"; text: string };

/**
 * Whether the program copes with this read coming back empty. Pass
 * `variable` for a read of the environment, so a test that spells the
 * read another way still counts.
 */
export function isDefaultedAt(read: RbNode, variable?: EnvSpelling): boolean {
  const subject: ReadSubject =
    variable === undefined
      ? { kind: "spelling", text: read.text }
      : { kind: "variable", spelling: variable };
  if (hasFallbackOperand(read) || isPresentAt(read, subject)) {
    return true;
  }
  if (variable?.raises === true) {
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

function isSubject(subject: ReadSubject, expression: RbNode): boolean {
  if (subject.kind === "local") {
    return refersTo(expression, subject.local);
  }
  if (subject.kind === "variable") {
    return readsVariable(expression, subject.spelling);
  }
  return expression.text === subject.text;
}

function readsVariable(expression: RbNode, spelling: EnvSpelling): boolean {
  const other = envSpellingAt(expression);
  return other !== null && isSameName(other.name, spelling.name);
}

/** Only an environment read has a key that `ENV.key?("X")` asks about. */
function isKeyOfSubject(
  subject: ReadSubject,
  key: RbNode,
  container: RbNode,
): boolean {
  return (
    subject.kind === "variable" &&
    isEnv(container) &&
    isSameName(key, subject.spelling.name)
  );
}

/**
 * Whether an `||` supplies a value when this read comes back nil. The
 * climb continues through a chain, so B in `A || B || "d"` counts, and
 * stops where the read is the final operand and is itself the fallback.
 */
function hasFallbackOperand(node: RbNode): boolean {
  let child = node;
  let parent = node.parent;
  while (parent !== null) {
    if (parent.type === "parenthesized_statements") {
      child = parent;
      parent = parent.parent;
      continue;
    }
    if (parent.type !== "binary" || field(parent, "operator")?.text !== "||") {
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
 * Which branch of each conditional form runs on which outcome of its
 * condition. A loop's body runs while its condition holds, and an
 * `until` loop's while it does not.
 */
const BRANCHES: Record<string, { whenTrue?: string; whenFalse?: string }> = {
  if: { whenTrue: "consequence", whenFalse: "alternative" },
  elsif: { whenTrue: "consequence", whenFalse: "alternative" },
  conditional: { whenTrue: "consequence", whenFalse: "alternative" },
  unless: { whenTrue: "alternative", whenFalse: "consequence" },
  if_modifier: { whenTrue: "body" },
  unless_modifier: { whenFalse: "body" },
  while: { whenTrue: "body" },
  while_modifier: { whenTrue: "body" },
  until: { whenFalse: "body" },
  until_modifier: { whenFalse: "body" },
};

/** The forms a method leaves early through: `return x unless ok`, or an `if` whose body returns. */
const EARLY_EXIT_TYPES = new Set([
  "if",
  "unless",
  "if_modifier",
  "unless_modifier",
]);

const LOGICAL_OPERATORS = new Set(["&&", "||", "and", "or"]);

const LEAVING_TYPES = new Set(["return", "next", "break"]);

/** Where statements run one after another. */
const STATEMENT_LIST_TYPES = new Set([
  "program",
  "body_statement",
  "then",
  "else",
  "do",
  "begin",
  "block_body",
]);

/** The methods Ruby asks a hash about a key with, which `ENV` also has. */
const MEMBERSHIP_METHODS = new Set(["key?", "has_key?", "include?", "member?"]);

/**
 * Whether the value is only tested here and never passed on: `if x`,
 * `!x`, `x.nil?`, `x == nil`, or a ternary's condition. An `&&` or `||`
 * operand counts when the whole expression is tested the same way or
 * its result is thrown away.
 */
function isPresenceTest(node: RbNode): boolean {
  let child = climbParens(node);
  let throughLogical = false;
  let parent = child.parent;
  while (parent !== null) {
    if (isNegation(parent) || isNilCheckOn(parent, child)) {
      return true;
    }
    if (parent.type === "binary" && !isLogical(parent)) {
      return comparedWithNil(parent)?.tested.id === child.id;
    }
    if (parent.type !== "binary") {
      return (
        (parent.type in BRANCHES &&
          field(parent, "condition")?.id === child.id) ||
        (throughLogical && STATEMENT_LIST_TYPES.has(parent.type))
      );
    }
    throughLogical = true;
    child = climbParens(parent);
    parent = child.parent;
  }
  return false;
}

/**
 * Whether some enclosing test has already passed by the time `node`
 * runs: `node` is in the branch a present value takes, or it follows a
 * statement that leaves on the absent branch.
 */
function isPresentAt(node: RbNode, subject: ReadSubject): boolean {
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
  parent: RbNode,
  child: RbNode,
  subject: ReadSubject,
): boolean {
  if (parent.type === "binary") {
    const left = field(parent, "left");
    const operator = field(parent, "operator")?.text ?? "";
    return (
      isLogical(parent) &&
      field(parent, "right")?.id === child.id &&
      left !== null &&
      isPresentWhen(left, operator === "&&" || operator === "and", subject)
    );
  }
  const branches = BRANCHES[parent.type];
  const test = field(parent, "condition");
  if (branches === undefined || test === null) {
    return false;
  }
  const taken = branchTakenBy(parent, child, branches);
  return taken !== null && isPresentWhen(test, taken, subject);
}

/** The outcome of the condition under which `child` runs, or null when it runs either way. */
function branchTakenBy(
  parent: RbNode,
  child: RbNode,
  branches: { whenTrue?: string; whenFalse?: string },
): boolean | null {
  if (
    branches.whenTrue !== undefined &&
    field(parent, branches.whenTrue)?.id === child.id
  ) {
    return true;
  }
  if (
    branches.whenFalse !== undefined &&
    field(parent, branches.whenFalse)?.id === child.id
  ) {
    return false;
  }
  return null;
}

/**
 * Whether an earlier statement in the same body leaves when the value is
 * missing: `return unless x`, or an `if !x` whose body returns. Raising
 * does not count: a program that raises has not coped with the value
 * being missing.
 */
function followsExitWhenAbsent(
  parent: RbNode,
  child: RbNode,
  subject: ReadSubject,
): boolean {
  if (!STATEMENT_LIST_TYPES.has(parent.type)) {
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

function leavesWhenAbsent(statement: RbNode, subject: ReadSubject): boolean {
  const branches = BRANCHES[statement.type];
  const test = field(statement, "condition");
  const body = field(statement, "consequence") ?? field(statement, "body");
  if (
    !EARLY_EXIT_TYPES.has(statement.type) ||
    branches === undefined ||
    test === null ||
    body === null ||
    !alwaysLeaves(body)
  ) {
    return false;
  }
  const runsWhen = branchTakenBy(statement, body, branches);
  return runsWhen !== null && isPresentWhen(test, !runsWhen, subject);
}

/** A `return`, `next` or `break`, alone or among a body's own statements. */
function alwaysLeaves(body: RbNode): boolean {
  if (LEAVING_TYPES.has(body.type)) {
    return true;
  }
  return body.namedChildren.some(
    (statement) => statement !== null && LEAVING_TYPES.has(statement.type),
  );
}

/**
 * Whether the subject has a value once `test` has come out as `outcome`.
 * Only `nil` and `false` are falsy in Ruby, so a truthy test rules out a
 * missing variable and nothing else.
 */
function isPresentWhen(
  test: RbNode,
  outcome: boolean,
  subject: ReadSubject,
): boolean {
  const expression = peelParens(test);
  if (isSubject(subject, expression)) {
    return outcome;
  }
  if (isNegation(expression)) {
    const operand = field(expression, "operand");
    return operand !== null && isPresentWhen(operand, !outcome, subject);
  }
  if (expression.type === "call") {
    return isPresentAfterCall(expression, outcome, subject);
  }
  if (expression.type !== "binary") {
    return false;
  }
  if (isLogical(expression)) {
    return isPresentAfterLogical(expression, outcome, subject);
  }
  const compared = comparedWithNil(expression);
  return (
    compared !== null &&
    isSubject(subject, compared.tested) &&
    outcome === compared.saysDifferent
  );
}

function isPresentAfterLogical(
  expression: RbNode,
  outcome: boolean,
  subject: ReadSubject,
): boolean {
  const operator = field(expression, "operator")?.text;
  // `a && b` true says both are true, `a || b` false says both are false.
  if ((operator === "&&" || operator === "and") !== outcome) {
    return false;
  }
  return [field(expression, "left"), field(expression, "right")].some(
    (operand) => operand !== null && isPresentWhen(operand, outcome, subject),
  );
}

/** `x.nil?` false, or `ENV.key?("X")` true. */
function isPresentAfterCall(
  call: RbNode,
  outcome: boolean,
  subject: ReadSubject,
): boolean {
  const receiver = field(call, "receiver");
  const method = field(call, "method")?.text ?? "";
  if (receiver === null) {
    return false;
  }
  if (method === "nil?") {
    return !outcome && isSubject(subject, peelParens(receiver));
  }
  const key = readCallArgs(field(call, "arguments")).positional[0];
  return (
    outcome &&
    MEMBERSHIP_METHODS.has(method) &&
    key !== undefined &&
    isKeyOfSubject(subject, key, peelParens(receiver))
  );
}

/**
 * The operand a comparison sets against `nil` with `==` or `!=`, and
 * whether the comparison is true when the two differ.
 */
function comparedWithNil(
  comparison: RbNode,
): { tested: RbNode; saysDifferent: boolean } | null {
  const operator = field(comparison, "operator")?.text;
  const left = field(comparison, "left");
  const right = field(comparison, "right");
  if (
    (operator !== "==" && operator !== "!=") ||
    left === null ||
    right === null
  ) {
    return null;
  }
  const saysDifferent = operator === "!=";
  if (peelParens(right).type === "nil") {
    return { tested: peelParens(left), saysDifferent };
  }
  return peelParens(left).type === "nil"
    ? { tested: peelParens(right), saysDifferent }
    : null;
}

function isLogical(binary: RbNode): boolean {
  return LOGICAL_OPERATORS.has(field(binary, "operator")?.text ?? "");
}

function isNegation(node: RbNode): boolean {
  const operator = field(node, "operator")?.text;
  return node.type === "unary" && (operator === "!" || operator === "not");
}

function isNilCheckOn(call: RbNode, receiver: RbNode): boolean {
  return (
    call.type === "call" &&
    field(call, "method")?.text === "nil?" &&
    field(call, "receiver")?.id === receiver.id
  );
}

/** The expression inside parentheses that contain only one, or the node itself. */
function peelParens(node: RbNode): RbNode {
  const inner =
    node.type === "parenthesized_statements" && node.namedChildCount === 1
      ? node.namedChildren[0]
      : null;
  return inner === null || inner === undefined ? node : peelParens(inner);
}

function climbParens(node: RbNode): RbNode {
  let current = node;
  while (
    current.parent?.type === "parenthesized_statements" &&
    current.parent.namedChildCount === 1
  ) {
    current = current.parent;
  }
  return current;
}

/** A local the read initializes, the method or block it belongs to, and the key its uses share. */
interface Local {
  name: RbNode;
  owner: RbNode;
  key: string;
}

/**
 * The local `x = <read>` writes, when `x` belongs to a method or a
 * block. A name in the file body is visible to everything the file
 * runs, where its uses are harder to see.
 */
function localNamedBy(read: RbNode): Local | null {
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
  if (name === null || name.type !== "identifier") {
    return null;
  }
  const owner = ownerOfName(name, name.text, enclosingDefinition(name));
  return owner === null ? null : { name, owner, key: bindingKeyOf(name) };
}

/**
 * The key the value facts give a name where it is written. The file path
 * only prefixes the key, and every key compared here comes from one file.
 */
function bindingKeyOf(name: RbNode): string {
  return readKey("", name, enclosingDefinition(name));
}

function refersTo(identifier: RbNode, local: Local): boolean {
  return (
    identifier.type === "identifier" &&
    identifier.text === local.name.text &&
    bindingKeyOf(identifier) === local.key
  );
}

/** Every place the local is read or written, other than the assignment the read is in. */
function usesOf(local: Local): RbNode[] {
  return local.owner
    .descendantsOfType("identifier")
    .filter(
      (identifier): identifier is RbNode =>
        identifier !== null &&
        identifier.id !== local.name.id &&
        refersTo(identifier, local),
    );
}

/** Whether a missing value never reaches this use. */
function isSafeUse(use: RbNode, subject: ReadSubject): boolean {
  return (
    hasFallbackOperand(use) || isPresenceTest(use) || isPresentAt(use, subject)
  );
}
