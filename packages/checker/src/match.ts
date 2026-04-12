import type { Predicate, ValueRef } from "@suss/behavioral-ir";

export type MatchResult = "match" | "nomatch" | "unknown";

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

function predicateContainsOpaque(p: Predicate): boolean {
  switch (p.type) {
    case "opaque":
      return true;
    case "compound":
      return p.operands.some(predicateContainsOpaque);
    case "negation":
      return predicateContainsOpaque(p.operand);
    default:
      return false;
  }
}

function predicateContainsUnresolved(p: Predicate): boolean {
  switch (p.type) {
    case "nullCheck":
    case "truthinessCheck":
    case "typeCheck":
    case "propertyExists":
      return valueRefContainsUnresolved(p.subject);
    case "comparison":
      return (
        valueRefContainsUnresolved(p.left) ||
        valueRefContainsUnresolved(p.right)
      );
    case "call":
      return p.args.some(valueRefContainsUnresolved);
    case "compound":
      return p.operands.some(predicateContainsUnresolved);
    case "negation":
      return predicateContainsUnresolved(p.operand);
    case "opaque":
      return false;
  }
}
