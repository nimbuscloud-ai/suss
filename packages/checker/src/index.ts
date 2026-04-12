import type {
  BehavioralSummary,
  Finding,
  Predicate,
  ValueRef,
} from "@suss/behavioral-ir";

export { type MatchResult, predicatesMatch, subjectsMatch } from "./match.js";

export function checkPair(
  _provider: BehavioralSummary,
  _consumer: BehavioralSummary,
): Finding[] {
  return [];
}

export type { BehavioralSummary, Finding, Predicate, ValueRef };
