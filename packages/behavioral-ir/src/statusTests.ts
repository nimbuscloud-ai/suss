/**
 * Whether a condition tests the status of a response, read the same way
 * by the adapter that records a caller's branches and by the checker that
 * compares them with what a provider sends.
 *
 * Each client's pack lists the members a caller reads the status from:
 * `res.status` and `res.ok` for fetch, `resp.status_code` for requests,
 * `resp.status` for Faraday. A test reads a status when one of the values
 * it compares or checks ends in one of those members. A pack that lists
 * none gets the ones fetch uses.
 */

import type { Predicate, ValueRef } from "./index.js";

/** The members a status is read from when the client's pack lists none. */
export const DEFAULT_STATUS_ACCESSORS: readonly string[] = [
  "status",
  "statusCode",
];

/** The members that say a request succeeded when the client's pack lists none. */
export const DEFAULT_SUCCESS_ACCESSORS: readonly string[] = ["ok"];

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
  compound: (p) => p.operands.flatMap(predicateRefs),
  negation: (p) => predicateRefs(p.operand),
  opaque: () => [],
};

/** Every value a condition compares or checks, through `and`, `or` and `not`. */
export function predicateRefs(p: Predicate): ValueRef[] {
  return (REFS_OF[p.type] as (q: Predicate) => ValueRef[])(p);
}

/**
 * Whether the last member `v` reads is one of `members`. A destructured
 * name counts as a read of the field it was taken from, so
 * `const { status } = await call()` makes a later `status === 404` a read
 * of `status`.
 */
export function refEndsInMember(
  v: ValueRef,
  members: ReadonlySet<string>,
): boolean {
  if (v.type === "derived") {
    if (v.derivation.type === "destructured") {
      return members.has(v.derivation.field);
    }
    if (v.derivation.type === "propertyAccess") {
      return members.has(v.derivation.property);
    }
  }
  if (v.type === "input") {
    const last = v.path[v.path.length - 1];
    return last !== undefined && members.has(last);
  }
  if (v.type === "dependency") {
    const last = v.accessChain[v.accessChain.length - 1];
    return last !== undefined && members.has(last);
  }
  return false;
}

/** The members a caller reads a status or a success flag from, with the defaults for a list the pack left out. */
export function statusMembersOf(accessors: {
  statusAccessors?: readonly string[] | undefined;
  successAccessors?: readonly string[] | undefined;
}): ReadonlySet<string> {
  const named = (
    given: readonly string[] | undefined,
    fallback: readonly string[],
  ): readonly string[] =>
    given === undefined || given.length === 0 ? fallback : given;
  return new Set([
    ...named(accessors.statusAccessors, DEFAULT_STATUS_ACCESSORS),
    ...named(accessors.successAccessors, DEFAULT_SUCCESS_ACCESSORS),
  ]);
}

/** Whether a condition reads one of these status members. */
export function testsStatus(
  p: Predicate,
  members: ReadonlySet<string>,
): boolean {
  return predicateRefs(p).some((ref) => refEndsInMember(ref, members));
}
