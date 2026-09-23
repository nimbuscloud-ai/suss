import type { Predicate, ValueRef } from "@suss/behavioral-ir";
import type { MatchResult } from "@suss/ir-core";

// The intent checker shares MatchResult, so it lives in @suss/ir-core.
// The comparators below depend on the behavioural predicate model and
// stay here.
export type { MatchResult } from "@suss/ir-core";

export function subjectsMatch(a: ValueRef, b: ValueRef): MatchResult {
  if (valueRefContainsUnresolved(a) || valueRefContainsUnresolved(b)) {
    return "unknown";
  }
  return JSON.stringify(a) === JSON.stringify(b) ? "match" : "nomatch";
}

export function predicatesMatch(a: Predicate, b: Predicate): MatchResult {
  if (predicateContainsOpaque(a) || predicateContainsOpaque(b)) {
    return "unknown";
  }
  if (predicateContainsUnresolved(a) || predicateContainsUnresolved(b)) {
    return "unknown";
  }
  if (a.type !== b.type) {
    return "nomatch";
  }
  return JSON.stringify(a) === JSON.stringify(b) ? "match" : "nomatch";
}

function valueRefContainsUnresolved(v: ValueRef): boolean {
  if (v.type === "unresolved") {
    return true;
  }
  if (v.type === "derived") {
    return valueRefContainsUnresolved(v.from);
  }
  return false;
}

/** A new predicate kind without an entry here fails the build (decision 8). */
type PredicateTests = {
  [K in Predicate["type"]]: (p: Extract<Predicate, { type: K }>) => boolean;
};

const CONTAINS_OPAQUE: PredicateTests = {
  opaque: () => true,
  compound: (p) => p.operands.some(predicateContainsOpaque),
  negation: (p) => predicateContainsOpaque(p.operand),
  nullCheck: () => false,
  truthinessCheck: () => false,
  typeCheck: () => false,
  propertyExists: () => false,
  comparison: () => false,
  call: () => false,
};

function predicateContainsOpaque(p: Predicate): boolean {
  return (CONTAINS_OPAQUE[p.type] as (q: Predicate) => boolean)(p);
}

const CONTAINS_UNRESOLVED: PredicateTests = {
  nullCheck: (p) => valueRefContainsUnresolved(p.subject),
  truthinessCheck: (p) => valueRefContainsUnresolved(p.subject),
  typeCheck: (p) => valueRefContainsUnresolved(p.subject),
  propertyExists: (p) => valueRefContainsUnresolved(p.subject),
  comparison: (p) =>
    valueRefContainsUnresolved(p.left) || valueRefContainsUnresolved(p.right),
  call: (p) => p.args.some(valueRefContainsUnresolved),
  compound: (p) => p.operands.some(predicateContainsUnresolved),
  negation: (p) => predicateContainsUnresolved(p.operand),
  // An opaque predicate has only source text, so it has no value
  // reference to be unresolved.
  opaque: () => false,
};

function predicateContainsUnresolved(p: Predicate): boolean {
  return (CONTAINS_UNRESOLVED[p.type] as (q: Predicate) => boolean)(p);
}
