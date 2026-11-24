/**
 * What an `if`, an `elif` or a conditional expression tests, for a run
 * of the value engine that takes one of its arms, and the condition each
 * arm runs under. Arm 0 is the one the condition being true takes, as
 * the lowering writes it.
 */

import { children, field } from "../ast.js";
import { peelValue } from "./lowering.js";
import { namesWrittenAgain } from "./soundLowering.js";

import type { ForkTest } from "@suss/values";
import type { PyNode } from "../parser.js";

/**
 * What a fork in `root` tests, for one evaluator, which keeps what each
 * root writes again. A condition two forks cannot be sure to share gets
 * a key of its own.
 */
export function forkTests(): (fork: PyNode, root: PyNode) => ForkTest | null {
  const writtenAgainByRoot = new Map<number, ReadonlySet<string>>();
  const writtenAgainIn = (root: PyNode): ReadonlySet<string> => {
    let again = writtenAgainByRoot.get(root.id);
    if (again === undefined) {
      again = namesWrittenAgain(root);
      writtenAgainByRoot.set(root.id, again);
    }
    return again;
  };
  return (fork, root) => {
    const condition = forkCondition(fork);
    if (condition === null) {
      return null;
    }
    const bare = peelParens(condition);
    const negated = bare.type === "not_operator";
    const argument = negated ? field(bare, "argument") : bare;
    if (argument === null) {
      return null;
    }
    const tested = peelParens(argument);
    const again = writtenAgainIn(root);
    const reads = namesReadIn(tested);
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
 * The condition a fork tests: an `if` or `elif`'s, or the middle of
 * `a if c else b`, which the lowering reads through any parentheses.
 */
export function forkCondition(fork: PyNode): PyNode | null {
  if (fork.type === "if_statement" || fork.type === "elif_clause") {
    return field(fork, "condition");
  }
  const bare = peelValue(fork);
  if (bare.type === "conditional_expression") {
    return children(bare)[1] ?? null;
  }
  return null;
}

function peelParens(node: PyNode): PyNode {
  let current = node;
  while (current.type === "parenthesized_expression") {
    const inner = children(current)[0];
    if (inner === undefined) {
      break;
    }
    current = inner;
  }
  return current;
}

// Two forks with the same text test the same value only when the
// condition calls nothing and writes nothing.
const UNPLAIN = new Set([
  "call",
  "await",
  "lambda",
  "named_expression",
  "yield",
]);

function containsType(node: PyNode, types: ReadonlySet<string>): boolean {
  return (
    types.has(node.type) ||
    children(node).some((child) => containsType(child, types))
  );
}

/** The names a condition reads, with an attribute after a `.` left out. */
function namesReadIn(condition: PyNode): string[] {
  const found = new Set<string>();
  const visit = (node: PyNode): void => {
    if (node.type === "identifier") {
      const parent = node.parent;
      const isAttribute =
        parent?.type === "attribute" &&
        field(parent, "attribute")?.id === node.id;
      if (!isAttribute) {
        found.add(node.text);
      }
      return;
    }
    for (const child of children(node)) {
      visit(child);
    }
  };
  visit(condition);
  return [...found];
}
