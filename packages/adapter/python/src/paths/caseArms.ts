/**
 * What one `case` of a `match` tests. The lowering writes a case's
 * condition text from this, and the predicate reader writes what it
 * compares, so the two always agree.
 *
 * A literal or a dotted name is compared with `==`, and `None` with
 * `is`. A class, a sequence or a mapping pattern matches some other way,
 * which the condition vocabulary cannot say, so it stays opaque and
 * quotes the source as `subject matches Point(x=0)`. A bare name or `_`
 * matches anything. A guard after the pattern must also be true.
 */

import { children, field, fields } from "../ast.js";

import type { PyNode } from "../parser.js";

/** The patterns compared with `==`. */
const LITERAL_TYPES = new Set([
  "string",
  "concatenated_string",
  "integer",
  "float",
  "true",
  "false",
]);

/** How one pattern is tested. */
export type PatternTest =
  | {
      readonly kind: "equals";
      readonly subject: PyNode;
      readonly pattern: PyNode;
    }
  | { readonly kind: "isNone"; readonly subject: PyNode }
  | {
      readonly kind: "matches";
      readonly subject: string;
      readonly pattern: string;
    };

export interface CaseArm {
  /** The case runs when any one of these passes. Empty when its pattern matches anything. */
  readonly tests: readonly PatternTest[];
  /** The `if` after the pattern, which must also be true. */
  readonly guard: PyNode | null;
}

/** What a `case` clause tests, or null for any other node. */
export function caseArmOf(node: PyNode): CaseArm | null {
  if (node.type !== "case_clause") {
    return null;
  }
  const match = node.parent?.parent ?? null;
  const subjects =
    match?.type === "match_statement" ? fields(match, "subject") : [];
  const patterns = children(node).filter(
    (child) => child.type === "case_pattern",
  );
  const guard = field(node, "guard")?.namedChild(0) ?? null;
  const [subject] = subjects;
  const [pattern] = patterns;
  if (
    subject === undefined ||
    pattern === undefined ||
    subjects.length > 1 ||
    patterns.length > 1
  ) {
    return {
      tests: [
        {
          kind: "matches",
          subject: subjects.map((one) => one.text).join(", "),
          pattern: patterns.map((one) => one.text).join(", "),
        },
      ],
      guard,
    };
  }
  return { tests: patternTests(subject, pattern), guard };
}

/** Whether the case runs whatever the subject is, as `case _` does. */
export function matchesAnything(arm: CaseArm): boolean {
  return arm.tests.length === 0 && arm.guard === null;
}

/** The nodes a case's test reads, or null for any other node. */
export function caseTestedNodes(node: PyNode): PyNode[] | null {
  if (node.type !== "case_clause") {
    return null;
  }
  const match = node.parent?.parent ?? null;
  const guard = field(node, "guard");
  return [
    ...(match?.type === "match_statement" ? fields(match, "subject") : []),
    ...children(node).filter((child) => child.type === "case_pattern"),
    ...(guard === null ? [] : [guard]),
  ];
}

/** One test per alternative of `"a" | "b"`, and none for a pattern that matches anything. */
function patternTests(subject: PyNode, pattern: PyNode): PatternTest[] {
  const inner =
    pattern.type === "case_pattern" ? pattern.namedChild(0) : pattern;
  if (inner === null) {
    return [];
  }
  if (inner.type === "as_pattern") {
    const bound = inner.namedChild(0);
    return bound === null ? [] : patternTests(subject, bound);
  }
  if (inner.type === "union_pattern") {
    const alternatives = children(inner).map((one) =>
      patternTests(subject, one),
    );
    return alternatives.some((one) => one.length === 0)
      ? []
      : alternatives.flat();
  }
  if (inner.type === "dotted_name" && children(inner).length === 1) {
    return [];
  }
  return [singleTest(subject, pattern, inner)];
}

/** A pattern written with more than its literal, such as `-1`, is matched and not compared. */
function singleTest(
  subject: PyNode,
  pattern: PyNode,
  inner: PyNode,
): PatternTest {
  const wholly = inner.text === pattern.text;
  if (wholly && inner.type === "none") {
    return { kind: "isNone", subject };
  }
  if (
    wholly &&
    (LITERAL_TYPES.has(inner.type) || inner.type === "dotted_name")
  ) {
    return { kind: "equals", subject, pattern: inner };
  }
  return { kind: "matches", subject: subject.text, pattern: pattern.text };
}

const TEST_TEXT: {
  [K in PatternTest["kind"]]: (
    test: Extract<PatternTest, { kind: K }>,
  ) => string;
} = {
  equals: (test) => `${test.subject.text} == ${test.pattern.text}`,
  isNone: (test) => `${test.subject.text} is None`,
  matches: (test) => `${test.subject} matches ${test.pattern}`,
};

/** One pattern's test written as Python would say it. */
export function patternTestText(test: PatternTest): string {
  return (TEST_TEXT[test.kind] as (one: PatternTest) => string)(test);
}

/** The case's test written as Python would say it, `verb == "put" or verb == "patch"`. */
export function caseArmText(arm: CaseArm): string {
  const tests = arm.tests.map(patternTestText);
  if (arm.guard === null) {
    return tests.join(" or ");
  }
  if (tests.length === 0) {
    return arm.guard.text;
  }
  const either = tests.length === 1 ? tests[0] : `(${tests.join(" or ")})`;
  return `${either} and ${arm.guard.text}`;
}
