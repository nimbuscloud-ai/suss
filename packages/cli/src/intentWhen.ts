/**
 * The `when` of each outcome in a drafted intent document: the conditions
 * a branch checked before it ended.
 *
 * A clause gives the boundary the guard read and what the guard found
 * there, using the same verbs as `results`. That way `reads` means one
 * thing across the document, and the clause stays correct after the
 * source renames a local variable. `boundaryGuardsOf` in `@suss/behavioral-ir`
 * matches guards to boundary calls.
 *
 * A guard on anything other than a boundary result or an input is written
 * as a sentence by `saidPlainly`. A fall-through branch lists its own
 * guards, and falls back to `OTHERWISE` only when the summary has none.
 */

import {
  boundaryCalls,
  boundaryGuardsOf,
  dispatchByType,
  displayLabel,
  groundBinding,
  guardSubject,
  polarityOf,
} from "@suss/behavioral-ir";

import { formatRef } from "./inspect.js";

import type {
  BehavioralSummary,
  BoundaryGuard,
  Deployment,
  DispatchTable,
  Polarity,
  Predicate,
  Transition,
  ValueRef,
} from "@suss/behavioral-ir";
import type { WhenClause } from "@suss/intent-ir";

/**
 * Used only for a fall-through branch whose guards the summary did not
 * record. Where the guards are known they are written out, because
 * "otherwise" silently changes meaning when someone adds a branch above.
 */
const OTHERWISE = "otherwise";

/** The `when` of the first branch when it has no guards. */
const ALWAYS = "every call reaches this outcome";

export function draftedWhen(
  transition: Transition,
  summary: BehavioralSummary,
  isFirst: boolean,
  deployment: Deployment,
): string | WhenClause[] {
  // Ground each binding against the deployment, so a store that the
  // template gives a name gets the same label here as in `results`.
  const named = boundaryGuardsOf(transition, boundaryCalls(summary)).map(
    (guard) => ({
      ...guard,
      binding: groundBinding(guard.binding, deployment),
    }),
  );
  const clauses = [
    ...boundaryClauses(named),
    ...transition.conditions
      .filter((condition) => !named.some((g) => g.condition === condition))
      .map(unnamedClause),
  ];
  if (clauses.length === 0) {
    return isFirst ? ALWAYS : OTHERWISE;
  }
  // A single plain-sentence guard is written inline, not as a list of one.
  const only = clauses[0];
  return clauses.length === 1 && typeof only === "string" ? only : clauses;
}

/**
 * One clause per boundary the branch's guards read. Guards that look
 * deeper into the same result go under `where`. That covers the else arm
 * of a lookup, where the row was found and one of its fields was checked.
 */
function boundaryClauses(guards: BoundaryGuard[]): WhenClause[] {
  const clauses: WhenClause[] = [];
  for (const [, group] of groupByBoundary(guards)) {
    const shortest = Math.min(...group.map((g) => g.path.length));
    const says = group.find(
      (g): g is BoundaryGuard & { polarity: Polarity } =>
        g.path.length === shortest && g.polarity !== null,
    );
    // A `where` drops the path that `finds` already covered, so it reads
    // `settledAt is set` instead of repeating the whole call.
    const shared = says?.path ?? [];
    const where = group
      .filter((g) => g !== says)
      .map((g) => saidOf(g, shared.length));
    const first = group[0];
    clauses.push({
      [first.does]: displayLabel(first.binding),
      ...(says !== undefined ? { finds: says.polarity } : {}),
      ...(where.length > 0 ? { where: where.join(" and ") } : {}),
    });
  }
  return clauses;
}

/**
 * The guard as a sentence, minus the path the clause already gave. The
 * whole condition is rendered, negation included, so the else arm of a
 * chain comes out as `settledAt is missing` and keeps its polarity.
 */
function saidOf(guard: BoundaryGuard, shared: number): string {
  const rest = guard.path.slice(shared);
  return saidPlainly(
    guard.condition,
    false,
    rest.length > 0 ? rest : guard.path.slice(-1),
  );
}

function groupByBoundary(
  guards: BoundaryGuard[],
): Map<string, BoundaryGuard[]> {
  const groups = new Map<string, BoundaryGuard[]>();
  for (const guard of guards) {
    const key = `${guard.does} ${displayLabel(guard.binding)}`;
    const bucket = groups.get(key);
    if (bucket === undefined) {
      groups.set(key, [guard]);
    } else {
      bucket.push(guard);
    }
  }
  return groups;
}

/**
 * A guard that does not read a boundary. A guard on the caller's input
 * becomes an `input` clause. Anything else stays a plain sentence.
 */
function unnamedClause(condition: Predicate): WhenClause {
  const subject = guardSubject(condition);
  if (subject === null || subject.input === null) {
    return saidPlainly(condition, false, []);
  }
  const path = [subject.input, ...subject.path].join(".");
  const state = INPUT_STATE[polarityOf(condition) ?? "unknown"];
  if (state !== undefined) {
    return { input: path, is: state };
  }
  return { input: path, where: saidPlainly(condition, false, subject.path) };
}

const INPUT_STATE: Record<string, string | undefined> = {
  something: "set",
  nothing: "missing",
};

// ---------------------------------------------------------------------------
// The fallback: a guard as a sentence
// ---------------------------------------------------------------------------

/**
 * Each guard becomes a sentence about the value it checks, with the value
 * written as the code writes it. Turning `invoiceId` into "the invoice id"
 * would guess at what the author calls it in prose.
 */
const PLAINLY: DispatchTable<
  Predicate,
  (negated: boolean, said: (ref: ValueRef) => string) => string
> = {
  comparison: (p) => (negated, said) =>
    aTypeofCheck(p, negated) ??
    `${said(p.left)} ${COMPARED[negated ? OPPOSITE[p.op] : p.op]} ${said(p.right)}`,
  truthinessCheck: (p) => (negated, said) =>
    p.negated === negated
      ? `${said(p.subject)} is set`
      : `${said(p.subject)} is missing`,
  nullCheck: (p) => (negated, said) =>
    p.negated === negated
      ? `${said(p.subject)} is null`
      : `${said(p.subject)} is not null`,
  typeCheck: (p) => (negated, said) =>
    negated
      ? `${said(p.subject)} is not a ${p.expectedType}`
      : `${said(p.subject)} is a ${p.expectedType}`,
  call: (p) => (negated, said) =>
    `${p.callee}(${p.args.map(said).join(", ")}) is ${negated ? "false" : "true"}`,
  propertyExists: (p) => (negated, said) =>
    p.negated === negated
      ? `${said(p.subject)} has "${p.property}"`
      : `${said(p.subject)} has no "${p.property}"`,
  compound: (p) => (negated, said) =>
    p.operands
      .map((operand) => dispatchByType(PLAINLY, operand)(negated, said))
      .join(p.op === "and" ? " and " : " or "),
  negation: (p) => (negated, said) =>
    dispatchByType(PLAINLY, p.operand)(!negated, said),
  // An opaque guard keeps its source text for the curator to rewrite.
  opaque: (p) => (negated) =>
    negated ? `not (${p.sourceText.trim()})` : p.sourceText.trim(),
};

/**
 * `path` is the part the enclosing clause already gave, and the sentence
 * starts after it: `settledAt is set` instead of
 * `dynamo.send().Item.settledAt is set`.
 */
export function saidPlainly(
  condition: Predicate,
  negated: boolean,
  path: string[],
): string {
  const said = path.length === 0 ? formatRef : afterTheShared(path);
  return dispatchByType(PLAINLY, condition)(negated, said);
}

function afterTheShared(path: string[]): (ref: ValueRef) => string {
  const tail = path.join(".");
  return (ref) => {
    const whole = formatRef(ref);
    return whole.endsWith(`.${tail}`) ? tail : whole;
  };
}

/**
 * `typeof x !== "string"` arrives as a comparison whose left side is
 * unresolved source text, and the general comparison sentence would come
 * out garbled. Returns null for any other comparison.
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
