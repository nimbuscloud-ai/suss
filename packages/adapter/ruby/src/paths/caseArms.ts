/**
 * What one arm of a `case` tests. The lowering writes an arm's condition
 * text from this, and the predicate reader writes what the arm compares,
 * so the two always agree.
 *
 * A `when` arm runs when one of its patterns `===` the case's subject.
 * For a literal that is `==`. A class, a range or a name matches some
 * other way, which the condition vocabulary cannot say, so it stays
 * opaque and quotes the source as `Integer === value`. With no subject,
 * each pattern is a condition of its own. An `in` arm matches a pattern
 * under its guard, and a bare name with no guard matches anything.
 */

import { children, field } from "../ast.js";

import type { RbNode } from "../parser.js";

/** The patterns `===` compares the way `==` does. */
const LITERAL_TYPES = new Set([
  "string",
  "simple_symbol",
  "delimited_symbol",
  "integer",
  "float",
  "nil",
  "true",
  "false",
]);

/** How one pattern is tested. */
export type PatternTest =
  | {
      readonly kind: "equals";
      readonly subject: RbNode;
      readonly pattern: RbNode;
    }
  | {
      readonly kind: "caseEquals";
      readonly subject: RbNode;
      readonly pattern: RbNode;
    }
  | {
      readonly kind: "matches";
      readonly subject: RbNode;
      readonly pattern: RbNode;
    }
  | { readonly kind: "condition"; readonly test: RbNode };

export interface CaseArm {
  /** The arm runs when any one of these passes. Empty when its pattern matches anything. */
  readonly tests: readonly PatternTest[];
  /** An `in` arm's `if` or `unless`, which must also be true. */
  readonly guard: { readonly test: RbNode; readonly negated: boolean } | null;
}

/** What a `when` or an `in` arm tests, or null for any other node. */
export function caseArmOf(node: RbNode): CaseArm | null {
  if (node.type === "when") {
    return whenArmOf(node);
  }
  const subject = subjectOf(node);
  if (node.type === "in_clause" && subject !== null) {
    const pattern = field(node, "pattern");
    return {
      tests: pattern === null ? [] : inTests(subject, pattern),
      guard: guardOf(field(node, "guard")),
    };
  }
  return null;
}

/** What a `when` arm tests, each of its patterns against the case's subject. */
export function whenArmOf(when: RbNode): CaseArm {
  const subject = subjectOf(when);
  const patterns = children(when).flatMap((child) => {
    const pattern = child.type === "pattern" ? child.namedChild(0) : null;
    return pattern === null ? [] : [pattern];
  });
  return {
    tests: patterns.map((pattern) => whenTest(subject, pattern)),
    guard: null,
  };
}

/** The value the arm's `case` is written on, or null for a `case` with none. */
function subjectOf(arm: RbNode): RbNode | null {
  return arm.parent === null ? null : field(arm.parent, "value");
}

/** Whether the arm runs whatever the subject is, as an `else` does. */
export function matchesAnything(arm: CaseArm): boolean {
  return arm.tests.length === 0 && arm.guard === null;
}

function whenTest(subject: RbNode | null, pattern: RbNode): PatternTest {
  if (subject === null) {
    return { kind: "condition", test: pattern };
  }
  return LITERAL_TYPES.has(pattern.type)
    ? { kind: "equals", subject, pattern }
    : { kind: "caseEquals", subject, pattern };
}

/** `in :a | :b` is one test per alternative, and a bare name is none, since it binds anything. */
function inTests(subject: RbNode, pattern: RbNode): PatternTest[] {
  if (pattern.type === "identifier") {
    return [];
  }
  if (pattern.type === "alternative_pattern") {
    return children(pattern).flatMap((alternative) =>
      inTests(subject, alternative),
    );
  }
  return LITERAL_TYPES.has(pattern.type)
    ? [{ kind: "equals", subject, pattern }]
    : [{ kind: "matches", subject, pattern }];
}

function guardOf(guard: RbNode | null): CaseArm["guard"] {
  const test = guard?.namedChild(0) ?? null;
  if (guard === null || test === null) {
    return null;
  }
  return { test, negated: guard.type === "unless_guard" };
}

const TEST_TEXT: {
  [K in PatternTest["kind"]]: (
    test: Extract<PatternTest, { kind: K }>,
  ) => string;
} = {
  equals: (test) => `${test.subject.text} == ${test.pattern.text}`,
  caseEquals: (test) => `${test.pattern.text} === ${test.subject.text}`,
  matches: (test) => `${test.subject.text} in ${test.pattern.text}`,
  condition: (test) => test.test.text,
};

/** One pattern's test written as Ruby would say it. */
export function patternTestText(test: PatternTest): string {
  return (TEST_TEXT[test.kind] as (one: PatternTest) => string)(test);
}

/** The arm's test written as Ruby would say it, `method == :put || method == :patch`. */
export function caseArmText(arm: CaseArm): string {
  const tests = arm.tests.map(patternTestText);
  if (arm.guard === null) {
    return tests.join(" || ");
  }
  const guard = arm.guard.negated
    ? `!(${arm.guard.test.text})`
    : arm.guard.test.text;
  if (tests.length === 0) {
    return guard;
  }
  const either = tests.length === 1 ? tests[0] : `(${tests.join(" || ")})`;
  return `${either} && ${guard}`;
}
