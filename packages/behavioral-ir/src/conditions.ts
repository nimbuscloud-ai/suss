/**
 * What a branch guard depends on, expressed as boundaries and not as
 * the local names the source used.
 *
 * A route that returns 404 when a table has no such row records that as
 * a truthiness check on the result of `dynamo.send`, and records
 * `dynamo.send` as a read of `aws.dynamodb:Invoices` in the same unit.
 * Joining the two shows that the 404 depends on a read of that table
 * finding nothing. That survives a rename of `dynamo`, and a checker
 * can compare it. The join covers the whole unit, because the call runs
 * before the branch and only the path past it records the effect.
 */

import { relationsOf } from "./relations.js";

import type { Relation } from "@suss/ir-core";
import type {
  BehavioralSummary,
  BoundaryBinding,
  Derivation,
  Predicate,
  Transition,
  ValueRef,
} from "./index.js";

/** Whether a guard passed because something was there, or was not. */
export type Polarity = "something" | "nothing";

/** The value a guard is about, reduced to where it came from. */
export interface GuardSubject {
  /** The call whose result the guard reads, when it reads one. */
  dependency: string | null;
  /** The input the guard reads, when it reads one. */
  input: string | null;
  /** The properties read off it, outermost last. */
  path: string[];
}

/** A guard, with the boundary its subject came from. */
export interface BoundaryGuard {
  does: Relation;
  binding: BoundaryBinding;
  /** The properties the guard read off the call's result. */
  path: string[];
  /** Null when the guard is not a presence check. */
  polarity: Polarity | null;
  /**
   * The transition's condition this came from, negation and all, so a
   * caller can tell which of its conditions are already accounted for.
   */
  condition: Predicate;
  /** The guard inside `condition`, the part a sentence about it writes out. */
  predicate: Predicate;
}

/** One call that crosses a boundary: what it does there, and which boundary. */
export interface BoundaryCall {
  does: Relation;
  binding: BoundaryBinding;
}

/**
 * The calls this unit makes that cross a boundary, keyed by callee. A
 * guard that reads one of their results is joined to its boundary
 * through this map.
 */
export function boundaryCalls(
  summary: BehavioralSummary,
): Map<string, BoundaryCall> {
  const byCallee = new Map<string, BoundaryCall>();
  for (const transition of summary.transitions) {
    for (const effect of transition.effects) {
      if (effect.type !== "interaction" || effect.callee === undefined) {
        continue;
      }
      for (const does of relationsOf(effect.interaction)) {
        if (does !== "provides" && !byCallee.has(effect.callee)) {
          byCallee.set(effect.callee, { does, binding: effect.binding });
        }
      }
    }
  }
  return byCallee;
}

/**
 * Every guard on this transition that can be joined to a boundary. A
 * guard the join cannot resolve is left out, and a caller that wants to
 * describe it writes out the guard itself.
 */
export function boundaryGuardsOf(
  transition: Transition,
  calls: Map<string, BoundaryCall>,
): BoundaryGuard[] {
  const guards: BoundaryGuard[] = [];
  for (const condition of transition.conditions) {
    const guard = boundaryGuard(condition, condition, calls, false);
    if (guard !== null) {
      guards.push(guard);
    }
  }
  return guards;
}

function boundaryGuard(
  condition: Predicate,
  outer: Predicate,
  calls: Map<string, BoundaryCall>,
  negated: boolean,
): BoundaryGuard | null {
  if (condition.type === "negation") {
    return boundaryGuard(condition.operand, outer, calls, !negated);
  }
  const subject = guardSubject(condition);
  if (subject === null || subject.dependency === null) {
    return null;
  }
  const call = calls.get(subject.dependency);
  if (call === undefined) {
    return null;
  }
  const passed = polarityOf(condition);
  return {
    does: call.does,
    binding: call.binding,
    path: subject.path,
    polarity: passed === null ? null : flipped(passed, negated),
    condition: outer,
    predicate: condition,
  };
}

function flipped(polarity: Polarity, negated: boolean): Polarity {
  if (!negated) {
    return polarity;
  }
  return polarity === "something" ? "nothing" : "something";
}

/**
 * Whether the guard passed because its subject was there. Null for any
 * other kind of guard, such as a comparison or a type check.
 */
export function polarityOf(condition: Predicate): Polarity | null {
  if (condition.type === "truthinessCheck") {
    return condition.negated ? "nothing" : "something";
  }
  if (condition.type === "nullCheck") {
    // `x == null` holds when there is nothing there.
    return condition.negated ? "something" : "nothing";
  }
  if (condition.type === "negation") {
    const inner = polarityOf(condition.operand);
    return inner === null ? null : flipped(inner, true);
  }
  return null;
}

/** The value a guard is about, or null when it is about several. */
export function guardSubject(condition: Predicate): GuardSubject | null {
  const ref = subjectRef(condition);
  return ref === null ? null : rootOf(ref, []);
}

function subjectRef(condition: Predicate): ValueRef | null {
  if (
    condition.type === "truthinessCheck" ||
    condition.type === "nullCheck" ||
    condition.type === "typeCheck" ||
    condition.type === "propertyExists"
  ) {
    return condition.subject;
  }
  if (condition.type === "comparison") {
    return condition.left;
  }
  if (condition.type === "negation") {
    return subjectRef(condition.operand);
  }
  return null;
}

/** The value a chain of property reads started from, and the reads. */
function rootOf(ref: ValueRef, path: string[]): GuardSubject | null {
  if (ref.type === "derived") {
    const step = namedStep(ref.derivation);
    return rootOf(ref.from, step === null ? path : [step, ...path]);
  }
  if (ref.type === "dependency") {
    return { dependency: ref.name, input: null, path };
  }
  if (ref.type === "input") {
    return {
      dependency: null,
      input: [ref.inputRef, ...ref.path].join("."),
      path,
    };
  }
  return null;
}

function namedStep(derivation: Derivation): string | null {
  if (derivation.type === "propertyAccess") {
    return derivation.property;
  }
  if (derivation.type === "destructured") {
    return derivation.field;
  }
  return null;
}
