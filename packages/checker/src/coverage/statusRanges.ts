/**
 * Which status codes a consumer branch admits, when the branch guards on a
 * range rather than on one number.
 *
 * A branch is described as a set of status codes. `and` intersects, `or`
 * unions, a negation complements. A predicate that says nothing about the
 * status gives null and stays out of the intersection, which is what stops a
 * consumer with no status check from looking like it covers everything.
 *
 * Comparisons against one number stay with `consumerExpectedStatuses`. The
 * README beside this file says why.
 */

import {
  statusAccessorsFor,
  successAccessorsFor,
} from "../contract/declaredContract.js";
import {
  refLooksLikeStatus,
  statusesNamedIn,
  type StatusAccessors,
} from "./responseMatch.js";

import type {
  BehavioralSummary,
  Predicate,
  ValueRef,
} from "@suss/behavioral-ir";

/** A run of status codes, both ends included. */
export interface StatusRange {
  min: number;
  max: number;
}

/**
 * The status codes a set may draw from. HTTP defines 100 through 599, and
 * complementing a range needs both ends, so a branch guarded on `!res.ok`
 * comes out as 100 to 199 plus 300 to 599 rather than as every integer.
 */
const STATUS_MIN = 100;
const STATUS_MAX = 599;

/** Sorted and non-overlapping, so intersect and complement can walk it once. */
type StatusSet = StatusRange[];

function normalise(ranges: StatusSet): StatusSet {
  const clipped = ranges
    .map((r) => ({
      min: Math.max(r.min, STATUS_MIN),
      max: Math.min(r.max, STATUS_MAX),
    }))
    .filter((r) => r.min <= r.max)
    .sort((a, b) => a.min - b.min);

  const merged: StatusRange[] = [];
  for (const r of clipped) {
    const last = merged[merged.length - 1];
    if (last !== undefined && r.min <= last.max + 1) {
      last.max = Math.max(last.max, r.max);
      continue;
    }
    merged.push({ ...r });
  }
  return merged;
}

function complement(set: StatusSet): StatusSet {
  const out: StatusRange[] = [];
  let cursor = STATUS_MIN;
  for (const r of set) {
    if (r.min > cursor) {
      out.push({ min: cursor, max: r.min - 1 });
    }
    cursor = Math.max(cursor, r.max + 1);
  }
  if (cursor <= STATUS_MAX) {
    out.push({ min: cursor, max: STATUS_MAX });
  }
  return out;
}

function intersect(a: StatusSet, b: StatusSet): StatusSet {
  const out: StatusRange[] = [];
  for (const x of a) {
    for (const y of b) {
      const min = Math.max(x.min, y.min);
      const max = Math.min(x.max, y.max);
      if (min <= max) {
        out.push({ min, max });
      }
    }
  }
  return normalise(out);
}

function union(a: StatusSet, b: StatusSet): StatusSet {
  return normalise([...a, ...b]);
}

function literalNumber(v: ValueRef): number | null {
  return v.type === "literal" && typeof v.value === "number" ? v.value : null;
}

const BOUND_BY_OP: Record<string, (n: number) => StatusRange> = {
  gte: (n) => ({ min: n, max: STATUS_MAX }),
  gt: (n) => ({ min: n + 1, max: STATUS_MAX }),
  lte: (n) => ({ min: STATUS_MIN, max: n }),
  lt: (n) => ({ min: STATUS_MIN, max: n - 1 }),
};

/** `400 <= status` describes what `status >= 400` does, read the other way. */
const FLIPPED_OP: Record<string, string> = {
  gte: "lte",
  gt: "lt",
  lte: "gte",
  lt: "gt",
};

function comparisonRange(
  pred: Extract<Predicate, { type: "comparison" }>,
  accessors: StatusAccessors,
): StatusSet | null {
  if (refLooksLikeStatus(pred.left, accessors)) {
    const n = literalNumber(pred.right);
    const bound = BOUND_BY_OP[pred.op];
    return n !== null && bound !== undefined ? [bound(n)] : null;
  }

  if (refLooksLikeStatus(pred.right, accessors)) {
    const n = literalNumber(pred.left);
    const flipped = FLIPPED_OP[pred.op];
    const bound = flipped !== undefined ? BOUND_BY_OP[flipped] : undefined;
    return n !== null && bound !== undefined ? [bound(n)] : null;
  }

  return null;
}

/**
 * A pack's success flag reads as the 2xx class. `res.ok` normally reaches the
 * checker already rewritten into a range, but a summary written by hand or by
 * an adapter that does not rewrite it arrives with the flag still on it.
 */
function truthinessRange(
  pred: Extract<Predicate, { type: "truthinessCheck" }>,
  successAccessors: StatusAccessors,
): StatusSet | null {
  if (!refLooksLikeStatus(pred.subject, successAccessors)) {
    return null;
  }
  const twoHundreds: StatusSet = [{ min: 200, max: 299 }];
  return pred.negated ? complement(twoHundreds) : twoHundreds;
}

function compoundRange(
  pred: Extract<Predicate, { type: "compound" }>,
  accessors: StatusAccessors,
  successAccessors: StatusAccessors,
): StatusSet | null {
  const parts = pred.operands.map((op) =>
    statusSetOf(op, accessors, successAccessors),
  );

  if (pred.op === "or") {
    // An operand saying nothing about the status can be true for any status,
    // so the `or` as a whole says nothing either.
    if (parts.some((p) => p === null)) {
      return null;
    }
    return (parts as StatusSet[]).reduce<StatusSet>(
      (acc, p) => union(acc, p),
      [],
    );
  }

  const known = parts.filter((p): p is StatusSet => p !== null);
  if (known.length === 0) {
    return null;
  }
  return known.reduce((acc, p) => intersect(acc, p));
}

function statusSetOf(
  pred: Predicate,
  accessors: StatusAccessors,
  successAccessors: StatusAccessors,
): StatusSet | null {
  if (pred.type === "comparison") {
    return comparisonRange(pred, accessors);
  }
  if (pred.type === "truthinessCheck") {
    return truthinessRange(pred, successAccessors);
  }
  if (pred.type === "compound") {
    return compoundRange(pred, accessors, successAccessors);
  }
  if (pred.type === "negation") {
    const inner = statusSetOf(pred.operand, accessors, successAccessors);
    return inner === null ? null : complement(inner);
  }
  return null;
}

/**
 * The status codes a consumer branch admits through a range guard, or null
 * when none of its conditions describes a range. Every condition on a branch
 * is true at the same time, so they intersect.
 */
export function branchStatusRanges(
  conditions: readonly Predicate[],
  accessors: StatusAccessors,
  successAccessors: StatusAccessors,
): StatusRange[] | null {
  const known = conditions
    .map((c) => statusSetOf(c, accessors, successAccessors))
    .filter((s): s is StatusSet => s !== null);

  if (known.length === 0) {
    return null;
  }
  return known.reduce((acc, s) => intersect(acc, s));
}

function rangesInclude(
  ranges: readonly StatusRange[],
  status: number,
): boolean {
  return ranges.some((r) => status >= r.min && status <= r.max);
}

/** Whether one branch handles `status`, by naming it or by admitting it. */
export function branchHandlesStatus(
  conditions: readonly Predicate[],
  accessors: StatusAccessors,
  successAccessors: StatusAccessors,
  status: number,
): boolean {
  if (statusesNamedIn(conditions, accessors).includes(status)) {
    return true;
  }
  const ranges = branchStatusRanges(conditions, accessors, successAccessors);
  return ranges !== null && rangesInclude(ranges, status);
}

/**
 * Whether any of the consumer's branches handles `status`. Two checks ask
 * this, and a consumer read as covered by one and uncovered by the other
 * is how the same code gets reported twice, once each way.
 */
export function consumerHandlesStatus(
  consumer: BehavioralSummary,
): (status: number) => boolean {
  const accessors = statusAccessorsFor(consumer);
  const successAccessors = successAccessorsFor(consumer);
  return (status) =>
    consumer.transitions.some((ct) =>
      branchHandlesStatus(ct.conditions, accessors, successAccessors, status),
    );
}
