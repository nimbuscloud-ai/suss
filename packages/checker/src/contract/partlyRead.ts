/**
 * Which parts of a handler suss read only in part.
 *
 * A finding that a handler produces an undeclared status, or never
 * produces a declared one, is a claim about every way the handler can
 * end. The claim holds only where suss read well enough. A path gated on
 * state some other code set (a field middleware put on the request,
 * `res.locals`) runs only on the routes that set it. A wrapper suss
 * could not read, or a throw the framework turns into a status, can end
 * the handler in ways no transition says. A middleware or filter that
 * was read and composed into the route counts like the handler's own
 * code. The README beside this file has the full rule.
 */

import {
  readsBesideTheRequest,
  readWrapperMetadata,
  wrapperFor,
} from "@suss/behavioral-ir";

import {
  hasOpaqueStatus,
  makeBoundary,
  makeSide,
} from "../coverage/responseMatch.js";

import type {
  BehavioralSummary,
  Finding,
  Predicate,
  Transition,
  ValueRef,
  WrapperIndex,
  WrapperReference,
} from "@suss/behavioral-ir";

/** A new predicate kind without an entry here fails the build (decision 8). */
type PredicateRefs = {
  [K in Predicate["type"]]: (p: Extract<Predicate, { type: K }>) => ValueRef[];
};

const REFS_OF: PredicateRefs = {
  nullCheck: (p) => [p.subject],
  truthinessCheck: (p) => [p.subject],
  typeCheck: (p) => [p.subject],
  propertyExists: (p) => [p.subject],
  comparison: (p) => [p.left, p.right],
  call: (p) => p.args,
  compound: (p) => p.operands.flatMap(refsOf),
  negation: (p) => refsOf(p.operand),
  opaque: () => [],
};

function refsOf(p: Predicate): ValueRef[] {
  return (REFS_OF[p.type] as (q: Predicate) => ValueRef[])(p);
}

/**
 * Whether a condition tests state some other code set, so the path runs
 * only on the routes that set it. An opaque condition hides when a path
 * runs, never whether it can, so it does not count.
 */
function conditionUnread(handler: BehavioralSummary, p: Predicate): boolean {
  return refsOf(p).some((ref) => readsBesideTheRequest(handler, ref));
}

/**
 * The finding a consumer gets in place of coverage findings when no pack
 * terminal matched part of what it does. The part suss did not read may
 * be where it handles a status, so no status is called unhandled.
 */
export function consumerReadInPart(
  provider: BehavioralSummary,
  consumer: BehavioralSummary,
): Finding | null {
  if (!consumer.gaps.some((gap) => gap.type === "unreadOutcome")) {
    return null;
  }
  return {
    kind: "lowConfidence",
    boundary: makeBoundary(provider, consumer),
    provider: makeSide(provider),
    consumer: makeSide(consumer),
    description:
      "Part of the consumer could not be read, so whether it handles each status the provider sends cannot be confirmed",
    severity: "info",
  };
}

/** Whether an error handler added this outcome without the run knowing it catches the throw. */
export function catchIsUncertain(transition: Transition): boolean {
  return readWrapperMetadata(transition)?.catchUncertain === true;
}

/**
 * Whether a path is gated on at least one condition suss could not read.
 * An error handler's outcome is gated on the handler catching the throw,
 * which counts when the run could not tell whether it does.
 */
export function reachedThroughUnreadCondition(
  handler: BehavioralSummary,
  transition: Transition,
): boolean {
  return (
    catchIsUncertain(transition) ||
    transition.conditions.some((p) => conditionUnread(handler, p))
  );
}

/**
 * The lowest status the handler may send on a path no transition
 * describes, so every status from it up is in doubt. Any status, when no
 * pack terminal matched part of what it produces or one of its statuses
 * could not be read. A redirect or a failure, when a wrapper in front of
 * it was not read, since a filter that stops a request does not send a
 * success. A failure, when it throws something no error handler on the
 * route surely catches, since the framework turns that into a status.
 * A call the walk could not follow in the handler itself is left out,
 * since a dependency it calls does not send the response. Infinity when
 * every path was read.
 */
export function lowestStatusSentUnread(
  handler: BehavioralSummary,
  wrappers: WrapperIndex,
): number {
  if (
    handler.gaps.some((gap) => gap.type === "unreadOutcome") ||
    handler.transitions.some(hasOpaqueStatus)
  ) {
    return 0;
  }

  const unreadWrapper = (readWrapperMetadata(handler)?.applied ?? []).some(
    (reference) =>
      runsOnARoutePath(handler, reference, wrappers) &&
      wrapperUnread(wrapperFor(wrappers, reference)),
  );
  if (unreadWrapper) {
    return 300;
  }
  return handler.transitions.some(reachesTheFramework)
    ? 400
    : Number.POSITIVE_INFINITY;
}

/**
 * Whether a wrapper runs on some path suss read. Middleware and filters
 * run on every request. An error handler registered for some exception
 * classes runs only for a throw of one of them, and composition added
 * its outcomes to the route exactly where some path throws one it may
 * catch. Where it added none, the handler could run only for a throw
 * from a call suss did not follow, which does not count here either.
 */
function runsOnARoutePath(
  handler: BehavioralSummary,
  reference: WrapperReference,
  wrappers: WrapperIndex,
): boolean {
  if (reference.onThrow !== true || reference.catches === undefined) {
    return true;
  }
  const own = wrapperFor(wrappers, reference);
  // With no outcomes to add, composition leaves no trace either way.
  if (own === undefined || own.transitions.length === 0) {
    return handler.transitions.some((t) => t.output.type === "throw");
  }
  return handler.transitions.some((transition) => {
    const from = readWrapperMetadata(transition)?.from;
    return from !== undefined && wrapperFor(wrappers, from) === own;
  });
}

/** Whether a path ends in a throw that no error handler on the route surely catches. */
function reachesTheFramework(transition: Transition): boolean {
  return (
    transition.output.type === "throw" &&
    readWrapperMetadata(transition)?.caught !== true
  );
}

/**
 * Whether a wrapper's outcomes are missing from the route it was
 * composed into: the run has no summary for it, part of it went unread,
 * or it makes a call suss could not follow where that call could send
 * the response. A filter that responds through a helper often does it
 * in that call.
 */
function wrapperUnread(wrapper: BehavioralSummary | undefined): boolean {
  if (wrapper === undefined) {
    return true;
  }
  return (
    wrapper.gaps.some(
      (gap) =>
        gap.type === "unreadOutcome" ||
        (gap.type === "unfollowedCall" && gap.usedAsValue !== true),
    ) || wrapper.transitions.some(hasOpaqueStatus)
  );
}
