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

import type { Derivation, Predicate, ValueRef } from "./index.js";

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

/** The members a body is read through when the client's pack lists none. */
export const DEFAULT_BODY_ACCESSORS: readonly string[] = ["body"];

/**
 * The members a caller reads a status from, and the members it reads the
 * body through. A status member read off the body, as in
 * `(await res.json()).status`, is a field the provider wrote, so it never
 * counts as the HTTP status.
 */
export interface StatusMembers {
  readonly members: ReadonlySet<string>;
  readonly body: ReadonlySet<string>;
}

/**
 * Every member `v` reads, from the value it starts at to the last one.
 * A dependency's name spells the members after its first segment, as
 * `res.json` does for the body of `res`.
 */
function membersRead(v: ValueRef): readonly string[] {
  if (v.type === "dependency") {
    return [...v.name.split(".").slice(1), ...v.accessChain];
  }
  if (v.type === "input") {
    return v.path;
  }
  if (v.type !== "derived") {
    return [];
  }
  const before = membersRead(v.from);
  const step = DERIVATION_MEMBER[v.derivation.type](v.derivation as never);
  return step === null ? before : [...before, step];
}

/** A new derivation kind without an entry here fails the build (decision 8). */
const DERIVATION_MEMBER: {
  [K in Derivation["type"]]: (
    d: Extract<Derivation, { type: K }>,
  ) => string | null;
} = {
  propertyAccess: (d) => d.property,
  destructured: (d) => d.field,
  methodCall: (d) => d.method,
  indexAccess: (d) => String(d.index),
  awaited: () => null,
};

/**
 * Whether `v` reads one of the status members off the response itself.
 * The last member read has to be a status member, read off a property, a
 * destructured name or a member chain, and no member before it may be
 * one the body is read through. A destructured name counts as a read of
 * the field it was taken from, so `const { status } = await call()` makes
 * a later `status === 404` a read of `status`.
 */
export function refEndsInMember(v: ValueRef, reads: StatusMembers): boolean {
  const lastIsMember =
    v.type === "derived"
      ? v.derivation.type === "propertyAccess" ||
        v.derivation.type === "destructured"
      : v.type === "input" || v.type === "dependency";
  const members = membersRead(v);
  const last = members[members.length - 1];
  if (!lastIsMember || last === undefined || !reads.members.has(last)) {
    return false;
  }
  return !members.slice(0, -1).some((member) => reads.body.has(member));
}

/** The list a pack gave, or the default when it gave none. */
function named(
  given: readonly string[] | undefined,
  fallback: readonly string[],
): readonly string[] {
  return given === undefined || given.length === 0 ? fallback : given;
}

/** The members a caller reads a status or a success flag from, and the body through, with the defaults for a list the pack left out. */
export function statusMembersOf(accessors: {
  statusAccessors?: readonly string[] | undefined;
  successAccessors?: readonly string[] | undefined;
  bodyAccessors?: readonly string[] | undefined;
}): StatusMembers {
  return {
    members: new Set([
      ...named(accessors.statusAccessors, DEFAULT_STATUS_ACCESSORS),
      ...named(accessors.successAccessors, DEFAULT_SUCCESS_ACCESSORS),
    ]),
    body: new Set(named(accessors.bodyAccessors, DEFAULT_BODY_ACCESSORS)),
  };
}

/** Whether a condition reads one of these status members off the response. */
export function testsStatus(p: Predicate, reads: StatusMembers): boolean {
  return predicateRefs(p).some((ref) => refEndsInMember(ref, reads));
}
