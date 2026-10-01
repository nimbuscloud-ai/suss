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

import { hasOpaqueStatus } from "../coverage/responseMatch.js";
import { predicateContainsOpaque } from "../match.js";

import type {
  BehavioralSummary,
  Predicate,
  Transition,
  ValueRef,
  WrapperIndex,
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

/** Whether suss could not read what a condition tests. */
function conditionUnread(handler: BehavioralSummary, p: Predicate): boolean {
  return (
    predicateContainsOpaque(p) ||
    refsOf(p).some((ref) => readsBesideTheRequest(handler, ref))
  );
}

/** Whether a path is gated on at least one condition suss could not read. */
export function reachedThroughUnreadCondition(
  handler: BehavioralSummary,
  transition: Transition,
): boolean {
  return transition.conditions.some((p) => conditionUnread(handler, p));
}

/**
 * Whether the handler can end with a failing status no transition names:
 * a wrapper in front of it was not read, it throws something the
 * framework turns into a status, a status could not be read, or no pack
 * terminal matched part of what it produces. A call the walk could not
 * follow is left out, since a dependency it calls does not send the
 * response.
 */
export function failuresSussCouldNotRead(
  handler: BehavioralSummary,
  wrappers: WrapperIndex,
): boolean {
  if (handler.gaps.some((gap) => gap.type === "unreadOutcome")) {
    return true;
  }

  const unreadWrapper = (readWrapperMetadata(handler)?.applied ?? []).some(
    (reference) => wrapperUnread(wrapperFor(wrappers, reference)),
  );
  if (unreadWrapper) {
    return true;
  }

  return handler.transitions.some(
    (t) => t.output.type === "throw" || hasOpaqueStatus(t),
  );
}

/**
 * Whether a wrapper's outcomes are missing from the route it was
 * composed into: the run has no summary for it, or part of it went
 * unread.
 */
function wrapperUnread(wrapper: BehavioralSummary | undefined): boolean {
  if (wrapper === undefined) {
    return true;
  }
  return (
    wrapper.gaps.some((gap) => gap.type === "unreadOutcome") ||
    wrapper.transitions.some(hasOpaqueStatus)
  );
}
