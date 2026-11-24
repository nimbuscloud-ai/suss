/**
 * What an `if`, an `unless`, a modifier, a ternary or a `case` tests,
 * for a run of the value engine that takes one of its arms, and the
 * condition each arm runs under. The lowering swaps an `unless`'s arms,
 * so arm 0 is always the one the condition being true takes, and a
 * `case`'s arms are its `when` clauses in order, then the `else`.
 */

import { children, field } from "../ast.js";
import { caseArmOf, caseArmText } from "../paths/caseArms.js";
import { peelValue } from "./lowering.js";
import { namesWrittenAgain } from "./soundLowering.js";

import type { ConditionInfo } from "@suss/extractor";
import type { ForkTest } from "@suss/values";
import type { RbNode } from "../parser.js";

const CONDITIONED = new Set([
  "if",
  "elsif",
  "unless",
  "if_modifier",
  "unless_modifier",
  "conditional",
]);

// Two forks with the same text test the same value only when the
// condition calls nothing and writes nothing.
const UNPLAIN = new Set([
  "call",
  "assignment",
  "operator_assignment",
  "yield",
  "lambda",
]);

/**
 * What a fork in `root` tests, for one evaluator, which keeps what each
 * root writes again. A condition two forks cannot be sure to share gets
 * a key of its own, as every `case` does.
 */
export function forkTests(): (fork: RbNode, root: RbNode) => ForkTest | null {
  const writtenAgainByRoot = new Map<number, ReadonlySet<string>>();
  const writtenAgainIn = (root: RbNode): ReadonlySet<string> => {
    let again = writtenAgainByRoot.get(root.id);
    if (again === undefined) {
      again = namesWrittenAgain(root);
      writtenAgainByRoot.set(root.id, again);
    }
    return again;
  };
  return (fork, root) => {
    if (fork.type === "case") {
      const subject = field(fork, "value");
      return {
        key: `case@${fork.startIndex}`,
        negated: false,
        reads: subject === null ? [] : namesReadIn(subject),
      };
    }
    const condition = conditionOf(fork);
    if (condition === null) {
      return null;
    }
    const bare = peelParens(condition);
    const negated = isNegation(bare);
    const tested = peelParens(
      negated ? (field(bare, "operand") ?? bare.namedChild(0) ?? bare) : bare,
    );
    const reads = namesReadIn(tested);
    const again = writtenAgainIn(root);
    const text = tested.text.replace(/\s+/g, " ");
    const shared =
      !containsType(tested, UNPLAIN) && !reads.some((name) => again.has(name));
    return {
      key: shared ? text : `${text}@${fork.startIndex}`,
      negated,
      reads,
    };
  };
}

/**
 * The condition one arm of a fork runs under, for the gate a client
 * reads: the test, or its negation for the second arm, or a `when`
 * clause's patterns. Null for a `case`'s `else`, which tests nothing of
 * its own.
 */
export function forkArmCondition(
  fork: RbNode,
  arm: number,
): ConditionInfo<RbNode> | null {
  if (fork.type === "case") {
    const when = children(fork).filter((clause) => clause.type === "when")[arm];
    const tested = when === undefined ? null : caseArmOf(when);
    return when === undefined || tested === null
      ? null
      : {
          sourceText: caseArmText(tested),
          polarity: "positive",
          source: "explicit",
          expression: when,
        };
  }
  const condition = conditionOf(fork);
  return condition === null
    ? null
    : {
        sourceText: condition.text,
        polarity: arm === 0 ? "positive" : "negative",
        source: "explicit",
        expression: condition,
      };
}

/** The condition a fork tests, a ternary read through any parentheses as the lowering reads it. */
function conditionOf(fork: RbNode): RbNode | null {
  const bare = peelValue(fork);
  return CONDITIONED.has(bare.type) ? field(bare, "condition") : null;
}

function isNegation(node: RbNode): boolean {
  const operator = field(node, "operator")?.text;
  return node.type === "unary" && (operator === "!" || operator === "not");
}

function peelParens(node: RbNode): RbNode {
  let current = node;
  while (current.type === "parenthesized_statements") {
    const inner = current.namedChild(0);
    if (inner === null) {
      break;
    }
    current = inner;
  }
  return current;
}

function containsType(node: RbNode, types: ReadonlySet<string>): boolean {
  return (
    types.has(node.type) ||
    children(node).some((child) => containsType(child, types))
  );
}

/** The local names a condition reads, `user` in `user.admin?`, with no method name. */
function namesReadIn(condition: RbNode): string[] {
  const found = new Set<string>();
  const visit = (node: RbNode): void => {
    if (node.type === "identifier") {
      found.add(node.text);
      return;
    }
    for (const child of children(node)) {
      visit(child);
    }
  };
  visit(condition);
  return [...found];
}
