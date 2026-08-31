/**
 * A branch guard as a sentence, for the `when` line of a drafted intent
 * document.
 *
 * `when` is free-form text the author owns, the same as the outcome id,
 * so a draft puts something readable there and the person curating the
 * file rewrites it. That is a different job from `formatCondition` in
 * `inspect.ts`, which writes the guard as the code has it for a reader
 * comparing a report against source.
 *
 * The else arm is the case worth knowing: a negated copy of the guard
 * above it says nothing a person would say, so a fall-through branch is
 * "otherwise" and its conditions go unread.
 */

import { dispatchByType } from "@suss/behavioral-ir";

import { formatRef } from "./inspect.js";

import type {
  DispatchTable,
  Predicate,
  Transition,
  ValueRef,
} from "@suss/behavioral-ir";

/** What the fall-through branch of a chain is, in one word. */
const OTHERWISE = "otherwise";

/** What a branch nothing guards is. */
const ALWAYS = "every call reaches this outcome";

export function draftedWhen(transition: Transition, isFirst: boolean): string {
  if (transition.isDefault && !isFirst) {
    return OTHERWISE;
  }
  if (transition.conditions.length === 0) {
    return ALWAYS;
  }

  return transition.conditions
    .map((condition) => saidPlainly(condition, false))
    .join(" and ");
}

/**
 * Each guard reads as a sentence about the value the code points at,
 * and that value keeps the spelling the code gave it, because turning
 * `invoiceId` into "the invoice id" would guess at what the author
 * calls it in prose.
 */
const PLAINLY: DispatchTable<Predicate, (negated: boolean) => string> = {
  comparison: (p) => (negated) =>
    aTypeofCheck(p, negated) ??
    `${value(p.left)} ${COMPARED[negated ? OPPOSITE[p.op] : p.op]} ${value(p.right)}`,
  truthinessCheck: (p) => (negated) =>
    p.negated === negated
      ? `${value(p.subject)} is set`
      : `${value(p.subject)} is missing`,
  nullCheck: (p) => (negated) =>
    p.negated === negated
      ? `${value(p.subject)} is null`
      : `${value(p.subject)} is not null`,
  typeCheck: (p) => (negated) =>
    negated
      ? `${value(p.subject)} is not a ${p.expectedType}`
      : `${value(p.subject)} is a ${p.expectedType}`,
  call: (p) => (negated) =>
    `${p.callee}(${p.args.map(value).join(", ")}) is ${negated ? "false" : "true"}`,
  propertyExists: (p) => (negated) =>
    p.negated === negated
      ? `${value(p.subject)} has "${p.property}"`
      : `${value(p.subject)} has no "${p.property}"`,
  compound: (p) => (negated) =>
    p.operands
      .map((operand) => saidPlainly(operand, negated))
      .join(p.op === "and" ? " and " : " or "),
  negation: (p) => (negated) => saidPlainly(p.operand, !negated),
  // A guard nothing above reads keeps the source text, which is what
  // the person curating the file rewrites.
  opaque: (p) => (negated) =>
    negated ? `not (${p.sourceText.trim()})` : p.sourceText.trim(),
};

function saidPlainly(condition: Predicate, negated: boolean): string {
  return dispatchByType(PLAINLY, condition)(negated);
}

/**
 * `typeof x !== "string"` arrives as a comparison whose left side is
 * source text, so the general form would write half a sentence. Null
 * when the comparison is anything else.
 */
function aTypeofCheck(
  p: Extract<Predicate, { type: "comparison" }>,
  negated: boolean,
): string | null {
  if (p.left.type !== "unresolved" || p.right.type !== "literal") {
    return null;
  }
  const named = /^typeof\s+(.+)$/.exec(p.left.sourceText.trim());
  if (named === null || (p.op !== "eq" && p.op !== "neq")) {
    return null;
  }
  const holds = (p.op === "eq") !== negated;
  return `${named[1]} is ${holds ? "a" : "not a"} ${String(p.right.value)}`;
}

function value(ref: ValueRef): string {
  return formatRef(ref);
}

const COMPARED: Record<string, string> = {
  eq: "is",
  neq: "is not",
  gt: "is more than",
  gte: "is at least",
  lt: "is less than",
  lte: "is at most",
};

const OPPOSITE: Record<string, string> = {
  eq: "neq",
  neq: "eq",
  gt: "lte",
  gte: "lt",
  lt: "gte",
  lte: "gt",
};
