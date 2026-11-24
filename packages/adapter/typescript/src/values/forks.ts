/**
 * What an `if`, a `?:` or a `switch` tests, for a run of the value
 * engine that takes one of its arms, and the condition each arm runs
 * under. The engine and the client unit both number a `switch`'s arms
 * through `switchArms`, so an arm the engine took is the clause the
 * condition is read from.
 */

import { Node, SyntaxKind } from "ts-morph";

import { parseConditionExpression } from "../predicates.js";
import { resolveSubject } from "../subjects.js";
import { peelParens, peelValue } from "../walk/unwrap.js";
import { switchArms } from "./lowering.js";
import { namesWrittenAgain } from "./soundLowering.js";

import type { Predicate } from "@suss/behavioral-ir";
import type { RawCondition } from "@suss/extractor";
import type { ForkTest } from "@suss/values";
import type { Expression, SwitchStatement } from "ts-morph";

const writtenAgainByRoot = new WeakMap<Node, ReadonlySet<string>>();

/**
 * What a fork in `root` tests, or null for a `switch` whose clauses fall
 * into each other, which a run must leave joined. A condition two forks
 * cannot be sure to share gets a key of its own.
 */
export function forkTestOf(fork: Node, root: Node): ForkTest | null {
  if (Node.isSwitchStatement(fork)) {
    const subject = fork.getExpression();
    return fallsThrough(fork)
      ? null
      : {
          key: `switch@${fork.getStart()}`,
          negated: false,
          reads: namesReadIn(subject),
        };
  }
  const condition = conditionOf(fork);
  if (condition === null) {
    return null;
  }
  const bare = peelParens(condition);
  const negated =
    Node.isPrefixUnaryExpression(bare) &&
    bare.getOperatorToken() === SyntaxKind.ExclamationToken;
  const tested = negated ? peelParens(bare.getOperand()) : bare;
  const text = tested.getText().replace(/\s+/g, " ");
  return {
    key: plainCondition(tested, root) ? text : `${text}@${fork.getStart()}`,
    negated,
    reads: namesReadIn(tested),
  };
}

/**
 * The condition an arm of a fork in `func` runs under: the test, or its
 * negation for the second arm, or a `switch` clause's labels. Null for a
 * `default` clause, which tests nothing of its own, and for a test on
 * the parameters of a function around `func`, which a caller of `func`
 * does not pass.
 */
export function forkArmCondition(
  fork: Node,
  arm: number,
  func: Node,
): RawCondition | null {
  if (readsOuterParameter(fork, func)) {
    return null;
  }
  if (Node.isSwitchStatement(fork)) {
    return switchArmCondition(fork, arm);
  }
  const condition = conditionOf(fork);
  if (condition === null) {
    return null;
  }
  return {
    sourceText: condition.getText(),
    structured: parseConditionExpression(condition),
    polarity: arm === 0 ? "positive" : "negative",
    source: "explicit",
  };
}

/**
 * What a `switch` arm runs under: the subject equals its label, or one of
 * the labels of the empty clauses that fall into it. Null for an arm a
 * `default` reaches, which runs for anything the other labels miss.
 */
function switchArmCondition(
  fork: SwitchStatement,
  arm: number,
): RawCondition | null {
  const clause = switchArms(fork)[arm];
  if (clause === undefined) {
    return null;
  }
  const clauses = fork.getClauses();
  const reached: Node[] = [clause];
  for (let at = clauses.indexOf(clause) - 1; at >= 0; at--) {
    const before = clauses[at];
    if (before === undefined || before.getStatements().length > 0) {
      break;
    }
    reached.unshift(before);
  }
  const labels = reached.flatMap((one) =>
    Node.isCaseClause(one) ? [one.getExpression()] : [],
  );
  if (labels.length < reached.length) {
    return null;
  }
  const subject = fork.getExpression();
  const tests: Predicate[] = labels.map((label) => ({
    type: "comparison",
    op: "eq",
    left: resolveSubject(subject),
    right: resolveSubject(label),
  }));
  const [only] = tests;
  return {
    sourceText: labels
      .map((label) => `${subject.getText()} === ${label.getText()}`)
      .join(" || "),
    structured:
      only !== undefined && tests.length === 1
        ? only
        : { type: "compound", op: "or", operands: tests },
    polarity: "positive",
    source: "explicit",
  };
}

/** Whether the fork's test reads a parameter of a function other than `func`. */
function readsOuterParameter(fork: Node, func: Node): boolean {
  const tested = Node.isSwitchStatement(fork)
    ? fork.getExpression()
    : conditionOf(fork);
  if (tested === null) {
    return false;
  }
  const identifiers = Node.isIdentifier(tested)
    ? [tested]
    : tested.getDescendantsOfKind(SyntaxKind.Identifier);
  return identifiers.some((id) => {
    const declaration = id.getSymbol()?.getDeclarations()[0];
    const parameter =
      declaration === undefined
        ? undefined
        : Node.isParameterDeclaration(declaration)
          ? declaration
          : declaration.getFirstAncestorByKind(SyntaxKind.Parameter);
    return parameter !== undefined && parameter.getParent() !== func;
  });
}

/** The condition a fork tests, a `?:` read through what the lowering peels. */
function conditionOf(fork: Node): Expression | null {
  if (Node.isIfStatement(fork)) {
    return fork.getExpression();
  }
  const bare = peelValue(fork);
  return Node.isConditionalExpression(bare) ? bare.getCondition() : null;
}

/**
 * Whether two forks with this condition's text test the same value: it
 * calls nothing and writes nothing, and every name it reads is written
 * at most once in the function.
 */
function plainCondition(condition: Node, root: Node): boolean {
  if (
    UNPLAIN.has(condition.getKind()) ||
    condition.getDescendants().some(isUnplain)
  ) {
    return false;
  }
  let writtenAgain = writtenAgainByRoot.get(root);
  if (writtenAgain === undefined) {
    writtenAgain = namesWrittenAgain(root);
    writtenAgainByRoot.set(root, writtenAgain);
  }
  const again = writtenAgain;
  return namesReadIn(condition).every((name) => !again.has(name));
}

const UNPLAIN = new Set([
  SyntaxKind.CallExpression,
  SyntaxKind.NewExpression,
  SyntaxKind.AwaitExpression,
  SyntaxKind.YieldExpression,
  SyntaxKind.TaggedTemplateExpression,
  SyntaxKind.DeleteExpression,
]);

function isUnplain(node: Node): boolean {
  if (UNPLAIN.has(node.getKind())) {
    return true;
  }
  if (Node.isBinaryExpression(node)) {
    const operator = node.getOperatorToken().getKind();
    return (
      operator >= SyntaxKind.FirstAssignment &&
      operator <= SyntaxKind.LastAssignment
    );
  }
  return (
    (Node.isPrefixUnaryExpression(node) ||
      Node.isPostfixUnaryExpression(node)) &&
    (node.getOperatorToken() === SyntaxKind.PlusPlusToken ||
      node.getOperatorToken() === SyntaxKind.MinusMinusToken)
  );
}

/** The names a condition reads, with a property name after a `.` left out. */
function namesReadIn(condition: Node): string[] {
  const identifiers = Node.isIdentifier(condition)
    ? [condition]
    : condition.getDescendantsOfKind(SyntaxKind.Identifier);
  const names = identifiers.flatMap((id) => {
    const parent = id.getParent();
    const isMember =
      parent !== undefined &&
      Node.isPropertyAccessExpression(parent) &&
      parent.getNameNode() === id;
    return isMember ? [] : [id.getText()];
  });
  const self = condition.getDescendantsOfKind(SyntaxKind.ThisKeyword);
  return [
    ...new Set([
      ...names,
      ...(self.length > 0 || condition.getKind() === SyntaxKind.ThisKeyword
        ? ["this"]
        : []),
    ]),
  ];
}

/** Whether a clause with statements runs on into the next one. */
function fallsThrough(node: SwitchStatement): boolean {
  const arms = switchArms(node);
  return arms.slice(0, -1).some((clause) => {
    const last = clause.getStatements().at(-1);
    return last === undefined || !ENDS_CLAUSE.has(endOf(last).getKind());
  });
}

/** The statement a clause ends on, through a block written around its statements. */
function endOf(statement: Node): Node {
  if (Node.isBlock(statement)) {
    const last = statement.getStatements().at(-1);
    return last === undefined ? statement : endOf(last);
  }
  return statement;
}

const ENDS_CLAUSE = new Set([
  SyntaxKind.BreakStatement,
  SyntaxKind.ReturnStatement,
  SyntaxKind.ThrowStatement,
  SyntaxKind.ContinueStatement,
]);
