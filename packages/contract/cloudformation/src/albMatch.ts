// albMatch.ts: how an ALB listener picks the match that takes a
// request, over the match records the ALB flow reader emits.
//
// This is the "alb" side of the routing match-language table: the
// glob rules (`*` crosses `/`, `?` is one character) and the ordering
// (lowest priority first, the listener's own default last) are ALB's,
// so they live here with the reader that owns the vocabulary, and the
// generic walk only dispatches to this selector by the language name.
//
// Conditions the reader marked unevaluated are never treated as
// admitting and never as refusing: a match gated on one is possible,
// not admitted, and everything such a match would shadow stays
// possible too. Only a match every one of whose conditions this
// selector can settle, standing where no earlier match could take the
// request first, is admitted outright.

import type {
  FlowRequest,
  RouterMatchSelector,
  RouterSelection,
  RoutingMatchCondition,
  RoutingMatchRecord,
} from "@suss/behavioral-ir";
import type { MatchResult } from "@suss/ir-core";

/** The condition language the ALB flow reader stamps on its match records. */
export const ALB_MATCH_LANGUAGE = "alb";

/**
 * An ALB pattern as a matcher: `*` matches any run of characters
 * including none and including `/`, `?` matches exactly one. Both are
 * ALB's own reading, which is the point of keeping this matcher out
 * of every other language's way.
 */
function albPatternRegex(pattern: string): RegExp {
  const source = pattern
    .split(/([*?])/g)
    .map((part) => {
      if (part === "*") {
        return ".*";
      }

      if (part === "?") {
        return ".";
      }

      return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${source}$`);
}

function albPatternMatches(pattern: string, value: string): boolean {
  return albPatternRegex(pattern).test(value);
}

type ConditionTester = (
  condition: RoutingMatchCondition,
  request: FlowRequest,
) => MatchResult;

/**
 * The condition fields this selector evaluates. Paths compare
 * case-sensitively, ALB's rule; hosts do not, DNS's rule. A request
 * that gives no host cannot settle a host-header condition, so that
 * condition abstains.
 */
const CONDITION_TESTERS: Record<string, ConditionTester> = {
  "path-pattern": (condition, request) =>
    condition.values.some((value) => albPatternMatches(value, request.path))
      ? "match"
      : "nomatch",
  "host-header": (condition, request) => {
    if (request.host === null) {
      return "unknown";
    }
    const host = request.host.toLowerCase();
    return condition.values.some((value) =>
      albPatternMatches(value.toLowerCase(), host),
    )
      ? "match"
      : "nomatch";
  },
};

/**
 * One condition against the request. Values within a field are ORed,
 * ALB's rule. A condition the reader marked unevaluated, or whose
 * field this selector has no tester for, abstains; a condition with
 * an evaluated field but nothing to compare (an empty Values list the
 * reader recorded as such) never admits.
 */
function conditionOutcome(
  condition: RoutingMatchCondition,
  request: FlowRequest,
): MatchResult {
  if (!condition.evaluated || condition.field === null) {
    return "unknown";
  }

  const tester = CONDITION_TESTERS[condition.field];
  if (tester === undefined) {
    return "unknown";
  }

  if (condition.values.length === 0) {
    return "nomatch";
  }

  return tester(condition, request);
}

/**
 * A whole match against the request. Conditions are ANDed across
 * fields, ALB's rule, so one refusing field refuses the match however
 * many others abstain; with no refusal, one abstaining field keeps
 * the match unsettled; a match with no conditions at all (a
 * listener's own default action) takes whatever reaches it.
 */
function matchOutcome(
  record: RoutingMatchRecord,
  request: FlowRequest,
): MatchResult {
  let unsettled = false;
  for (const condition of record.conditions) {
    const outcome = conditionOutcome(condition, request);
    if (outcome === "nomatch") {
      return "nomatch";
    }

    if (outcome === "unknown") {
      unsettled = true;
    }
  }
  return unsettled ? "unknown" : "match";
}

interface CandidateMatch {
  record: RoutingMatchRecord;
  outcome: MatchResult;
}

/**
 * Candidates in the order the listener consults them: ascending
 * priority, the priority-less default last. Two matches sharing a
 * priority stay adjacent and unordered between themselves, which is
 * the selection's problem to state, not this sort's to hide.
 */
function groupedByPriority(candidates: CandidateMatch[]): CandidateMatch[][] {
  const groups = new Map<number, CandidateMatch[]>();
  for (const candidate of candidates) {
    const rank = candidate.record.priority ?? Number.POSITIVE_INFINITY;
    const group = groups.get(rank) ?? [];
    group.push(candidate);
    groups.set(rank, group);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, group]) => group);
}

/**
 * The selection: walk the priority ladder and stop at the first rank
 * where some match settles the request. A settled match standing
 * alone, with nothing unsettled at its own rank or above it, takes
 * the request outright. Anything unsettled above it, or a tie between
 * settled matches at one rank (an ordering CFN lets a template
 * declare and a deploy would refuse), leaves every candidate up to
 * and including that rank possible instead. Below the first settled
 * rank nothing is reachable: whichever way the unsettled conditions
 * fall, some match at or above it has already taken the request.
 */
export const albRouterSelector: RouterMatchSelector = (
  records,
  request,
): RouterSelection => {
  const candidates = records
    .map((record) => ({ record, outcome: matchOutcome(record, request) }))
    .filter((candidate) => candidate.outcome !== "nomatch");

  const possible: string[] = [];
  for (const group of groupedByPriority(candidates)) {
    const settled = group.filter((candidate) => candidate.outcome === "match");
    const unsettled = group.filter(
      (candidate) => candidate.outcome === "unknown",
    );

    if (
      settled.length === 1 &&
      unsettled.length === 0 &&
      possible.length === 0
    ) {
      return { admitted: [settled[0].record.matchId], possible: [] };
    }

    possible.push(...group.map((candidate) => candidate.record.matchId));
    if (settled.length > 0) {
      return { admitted: [], possible };
    }
  }
  return { admitted: [], possible };
};
