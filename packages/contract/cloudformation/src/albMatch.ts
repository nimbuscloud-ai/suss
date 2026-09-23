/**
 * How an ALB listener picks which rule takes a request, given the match
 * records the ALB flow reader emits.
 *
 * The glob rules (`*` crosses `/`, `?` is one character) and the order
 * (lowest priority first, the listener's default last) are specific to
 * ALB, so they live next to the reader. The generic walk looks this
 * selector up by the "alb" language name.
 *
 * A condition the reader could not evaluate neither admits nor refuses.
 * A rule gated on one is only possible, and so is every rule it might
 * shadow. A rule is admitted outright only when every condition on it is
 * settled and no earlier rule could take the request first.
 */

import type {
  FlowRequest,
  RouterMatchSelector,
  RouterSelection,
  RoutingMatchCondition,
  RoutingMatchRecord,
} from "@suss/behavioral-ir";
import type { MatchResult } from "@suss/ir-core";

/** The match language on the ALB flow reader's match records. */
export const ALB_MATCH_LANGUAGE = "alb";

/**
 * ALB globbing: `*` matches any run of characters, `/` included, and `?`
 * matches exactly one.
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
 * Paths compare case-sensitively, as in ALB, and hosts do not, as in DNS.
 * A request with no host leaves a host-header condition unknown.
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
 * ALB ORs the values within one condition. An unevaluated condition or
 * an unknown field gives "unknown", and an empty Values list never matches.
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
 * ALB ANDs the conditions on a rule, so one "nomatch" rejects it and one
 * "unknown" leaves it unsettled. A listener's default has no conditions.
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
 * Groups by ascending priority, default last. Rules that share a priority
 * stay in one group so the selector can report the tie.
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
 * Walks the priorities in order and stops at the first one where some
 * rule matches. That rule is admitted when it is the only match there and
 * nothing at or above it is unsettled.
 *
 * Otherwise every candidate down to that priority is possible. This
 * covers an unsettled rule above it and two matching rules at one
 * priority, which a template can declare though a deploy would reject it.
 * Nothing below that priority can be reached, because some rule at or
 * above it has already taken the request.
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
