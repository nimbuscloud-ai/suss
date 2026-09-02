/**
 * What a branch turned on, for the `when` of a drafted intent document.
 *
 * A clause says which boundary the guard read and what it came back
 * with, in the verbs `results` uses, so `reads` means one thing in the
 * document and the line survives a rename of the variable the source
 * used. `boundaryGuardsOf` in `@suss/behavioral-ir` does the join.
 *
 * A guard whose subject is neither a boundary nor an input keeps the
 * sentence `saidPlainly` writes for it. A fall-through branch states
 * its own guards; `OTHERWISE` covers the one case that cannot.
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
 * The last resort for a fall-through branch, for one whose guards the
 * summary never recorded. A branch whose guards it did record says what
 * they were, because a word that means "not the ones above" changes
 * what it claims when somebody inserts a transition over it.
 */
const OTHERWISE = "otherwise";

/** What a branch nothing guards is. */
const ALWAYS = "every call reaches this outcome";

export function draftedWhen(
  transition: Transition,
  summary: BehavioralSummary,
  isFirst: boolean,
  deployment: Deployment,
): string | WhenClause[] {
  // A clause spells its boundary the way the rest of the document
  // does, so a store the template gives a name to gets that name here.
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
  // One guard nothing structural came out of reads better on the line
  // than under a list of one.
  const only = clauses[0];
  return clauses.length === 1 && typeof only === "string" ? only : clauses;
}

/**
 * One clause per boundary a branch turned on. Guards that read further
 * into the same result narrow it with `where`, which is what the else
 * arm of a lookup does: the row was there, and something about it held.
 */
function boundaryClauses(guards: BoundaryGuard[]): WhenClause[] {
  const clauses: WhenClause[] = [];
  for (const [, group] of groupByBoundary(guards)) {
    const shortest = Math.min(...group.map((g) => g.path.length));
    const says = group.find(
      (g): g is BoundaryGuard & { polarity: Polarity } =>
        g.path.length === shortest && g.polarity !== null,
    );
    // What `finds` already covered is what a `where` beside it leaves
    // out, so `settledAt is set` rather than the whole read back.
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
 * The guard as a sentence, with the part the clause already said cut
 * off. It renders the whole condition, negation included, so the else
 * arm of a chain says `settledAt is missing` rather than the opposite.
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
 * A guard that doesn't read a boundary. One that reads what the caller
 * sent says which input; anything else keeps its sentence.
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
 * Each guard reads as a sentence about the value the code points at,
 * and that value keeps the spelling the code gave it, because turning
 * `invoiceId` into "the invoice id" would guess at what the author
 * calls it in prose.
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
  // A guard nothing above reads keeps the source text, which is what
  // the person curating the file rewrites.
  opaque: (p) => (negated) =>
    negated ? `not (${p.sourceText.trim()})` : p.sourceText.trim(),
};

/**
 * `path` is what the clause around this one already said, so the
 * sentence writes what comes after it: `settledAt is set` rather than
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
