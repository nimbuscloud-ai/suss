/**
 * Which parts of a handler suss read only in part.
 *
 * A finding that a handler produces an undeclared status, or never
 * produces a declared one, is a claim about every way the handler can
 * end. The claim holds only for paths suss read well enough. A path
 * gated on an opaque condition, or on state some other code set (a
 * field middleware put on the request, `res.locals`), may or may not
 * run. A handler with middleware in front of it, or a throw the
 * framework turns into a status, can end in ways no transition says.
 * A local suss left unresolved still counts as read, since it is
 * usually what the handler looked up.
 */

import {
  readsBesideTheRequest,
  readWrapperMetadata,
} from "@suss/behavioral-ir";

import { hasOpaqueStatus } from "../coverage/responseMatch.js";
import { predicateContainsOpaque } from "../match.js";

import type {
  BehavioralSummary,
  Predicate,
  Transition,
  ValueRef,
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
 * middleware runs in front of it, it throws something the framework
 * turns into a status, a status could not be read, or no pack terminal
 * matched part of what it produces. A call the walk could not follow is
 * left out, since a dependency it calls does not send the response.
 */
export function failuresSussCouldNotRead(handler: BehavioralSummary): boolean {
  const middleware = readWrapperMetadata(handler)?.applied ?? [];
  if (middleware.length > 0) {
    return true;
  }

  if (handler.gaps.some((gap) => gap.type === "unreadOutcome")) {
    return true;
  }

  return handler.transitions.some(
    (t) => t.output.type === "throw" || hasOpaqueStatus(t),
  );
}
