import {
  readHttpMetadata,
  refEndsInMember,
  summaryRef,
} from "@suss/behavioral-ir";

import type {
  BehavioralSummary,
  BoundaryBinding,
  FindingSide,
  Predicate,
  StatusMembers,
  Transition,
  ValueRef,
} from "@suss/behavioral-ir";

export function extractResponseStatus(t: Transition): number | null {
  if (t.output.type !== "response") {
    return null;
  }
  const sc = t.output.statusCode;
  if (sc?.type === "literal" && typeof sc.value === "number") {
    return sc.value;
  }
  return null;
}

/** A response declared by class, such as "4XX", that arrives with some status in the range. */
export interface DeclaredStatusRange {
  min: number;
  max: number;
  /** The spelling in the source, for finding descriptions. */
  spec: string;
}

/**
 * The status range a provider transition declares, from the
 * `http.statusRange` a contract reader records when a document codes a
 * response as "2XX" rather than as one status.
 */
export function extractResponseStatusRange(
  t: Transition,
): DeclaredStatusRange | null {
  if (t.output.type !== "response") {
    return null;
  }
  return readHttpMetadata(t)?.statusRange ?? null;
}

/**
 * Whether a provider transition is a catch-all over every status the
 * other transitions leave out, the way an OpenAPI `default` response
 * is. A code-derived default branch has a literal status and stays out.
 */
export function isCatchAllResponse(t: Transition): boolean {
  return (
    t.isDefault &&
    t.output.type === "response" &&
    t.output.statusCode == null &&
    extractResponseStatusRange(t) === null
  );
}

/**
 * Whether a status code is in the 2xx class.
 *
 * Several checks ask this to decide whether a consumer's default branch
 * covers a provider status, so they have to agree on where the class
 * ends. Writing the range out at each of them is how one of them ends up
 * treating 300 as a success.
 */
export function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * Whether a summary is empty because suss could not read the handler.
 * Such a summary has no transitions and an `unreadOutcome` gap, and a
 * check that reasons from what a side does must not conclude that it
 * does nothing.
 */
export function nothingWasRead(summary: BehavioralSummary): boolean {
  return (
    summary.transitions.length === 0 &&
    summary.gaps.some((gap) => gap.type === "unreadOutcome")
  );
}

export function hasOpaqueStatus(t: Transition): boolean {
  if (t.output.type !== "response") {
    return false;
  }
  const sc = t.output.statusCode;
  return sc != null && sc.type !== "literal";
}

/**
 * The properties a consumer reads a status from, and the ones it reads
 * the body through, as returned by `statusAccessorsFor`. The consumer's
 * pack lists them, so a client with its own names needs no change here.
 */
export type StatusAccessors = StatusMembers;

export function consumerExpectedStatuses(
  t: Transition,
  accessors: StatusAccessors,
): number[] {
  return statusesNamedIn(t.conditions, accessors);
}

/** The same, for conditions read on their own rather than off a transition. */
export function statusesNamedIn(
  conditions: readonly Predicate[],
  accessors: StatusAccessors,
): number[] {
  const statuses: number[] = [];
  for (const pred of conditions) {
    collectStatusLiterals(pred, accessors, statuses);
  }
  return statuses;
}

function collectStatusLiterals(
  pred: Predicate,
  accessors: StatusAccessors,
  out: number[],
): void {
  if (pred.type === "comparison" && pred.op === "eq") {
    const literal = asStatusLiteral(pred.left, pred.right, accessors);
    if (literal != null) {
      out.push(literal);
    }
    return;
  }
  if (pred.type === "compound") {
    for (const op of pred.operands) {
      collectStatusLiterals(op, accessors, out);
    }
    return;
  }
  if (pred.type === "negation") {
    collectStatusLiterals(pred.operand, accessors, out);
  }
}

function asStatusLiteral(
  a: ValueRef,
  b: ValueRef,
  accessors: StatusAccessors,
): number | null {
  const pairs: Array<[ValueRef, ValueRef]> = [
    [a, b],
    [b, a],
  ];
  for (const [maybeRef, maybeLit] of pairs) {
    if (
      maybeLit.type === "literal" &&
      typeof maybeLit.value === "number" &&
      refLooksLikeStatus(maybeRef, accessors)
    ) {
      return maybeLit.value;
    }
  }
  return null;
}

/**
 * Whether `v` reads a status property, meaning its outermost accessor
 * is one of the given names.
 *
 * Provider coverage uses this too, to leave status comparisons out of
 * its sub-case discriminators, and the adapters read a caller's status
 * tests the same way, so all of them agree on what a status read is.
 */
export function refLooksLikeStatus(
  v: ValueRef,
  accessors: StatusAccessors,
): boolean {
  return refEndsInMember(v, accessors);
}

export function makeSide(
  summary: BehavioralSummary,
  transitionId?: string,
): FindingSide {
  const side: FindingSide = {
    summary: summaryRef(summary),
    location: summary.location,
  };
  if (transitionId) {
    side.transitionId = transitionId;
  }
  return side;
}

/** A finding side for several transitions of one summary that give the same finding. */
export function makeSideOfEach(
  summary: BehavioralSummary,
  transitionIds: readonly string[],
): FindingSide {
  const side = makeSide(summary, transitionIds[0]);
  if (transitionIds.length > 1) {
    side.transitionIds = [...transitionIds];
  }
  return side;
}

export function makeBoundary(
  provider: BehavioralSummary,
  consumer: BehavioralSummary,
): BoundaryBinding {
  return (
    provider.identity.boundaryBinding ??
    consumer.identity.boundaryBinding ?? {
      transport: "unknown",
      semantics: { name: "function-call" },
      recognition: "unknown",
    }
  );
}
