import {
  statusAccessorsFor,
  successAccessorsFor,
} from "../contract/declaredContract.js";
import { predicatesMatch } from "../match.js";
import {
  extractResponseStatus,
  hasOpaqueStatus,
  isSuccessStatus,
  makeBoundary,
  makeSide,
  refLooksLikeStatus,
  type StatusAccessors,
} from "./responseMatch.js";
import {
  branchHandlesStatus,
  branchStatusRanges,
  consumerHandlesStatus,
} from "./statusRanges.js";

import type {
  BehavioralSummary,
  Finding,
  Predicate,
  Transition,
} from "@suss/behavioral-ir";

export function checkProviderCoverage(
  provider: BehavioralSummary,
  consumer: BehavioralSummary,
): Finding[] {
  const findings: Finding[] = [];
  const boundary = makeBoundary(provider, consumer);
  const statusAccessors = statusAccessorsFor(consumer);
  const successAccessors = successAccessorsFor(consumer);

  const consumerHandles = consumerHandlesStatus(consumer);
  const consumerHasDefault = consumer.transitions.some((ct) => ct.isDefault);

  // Group provider transitions by status code for sub-case analysis
  const providerByStatus = new Map<number, Transition[]>();

  for (const pt of provider.transitions) {
    if (hasOpaqueStatus(pt)) {
      findings.push({
        kind: "lowConfidence",
        boundary,
        provider: makeSide(provider, pt.id),
        consumer: makeSide(consumer),
        description: `One of the provider's statuses could not be read, so coverage cannot be confirmed`,
        severity: "info",
      });
      continue;
    }

    const status = extractResponseStatus(pt);
    if (status == null) {
      continue;
    }

    if (
      !consumerHandles(status) &&
      !(consumerHasDefault && isSuccessStatus(status))
    ) {
      findings.push({
        kind: "unhandledProviderCase",
        boundary,
        provider: makeSide(provider, pt.id),
        consumer: makeSide(consumer),
        description: `Provider produces status ${status} but no consumer branch handles it`,
        severity: "error",
      });
      continue;
    }

    // Status is covered: track for sub-case analysis
    if (!providerByStatus.has(status)) {
      providerByStatus.set(status, []);
    }
    providerByStatus.get(status)?.push(pt);
  }

  // Sub-case analysis: when a provider has multiple transitions for the
  // same status code (e.g., two 200s gated by different conditions), check
  // whether the consumer distinguishes between them.
  for (const [status, providerTransitions] of providerByStatus) {
    if (providerTransitions.length <= 1) {
      continue;
    }

    // Find consumer transitions that handle this status
    const consumerForStatus = consumer.transitions.filter(
      (ct) =>
        (ct.isDefault && isSuccessStatus(status)) ||
        branchHandlesStatus(
          ct.conditions,
          statusAccessors,
          successAccessors,
          status,
        ),
    );

    // Extract non-status predicates from consumer transitions (the conditions
    // beyond "status === N" that distinguish sub-cases)
    const consumerNonStatusPredicates = consumerForStatus.flatMap((ct) =>
      getNonStatusConditions(ct, statusAccessors, successAccessors),
    );

    // If the consumer has no conditions beyond the status check, it's
    // collapsing all provider sub-cases into one branch
    if (consumerNonStatusPredicates.length === 0) {
      // Check if any provider sub-case has predicates the consumer ignores
      const conditionalProviderTransitions = providerTransitions.filter(
        (pt) => !pt.isDefault && pt.conditions.length > 0,
      );

      if (conditionalProviderTransitions.length > 0) {
        // Provider has N conditional sub-cases for this status, consumer
        // doesn't distinguish: emit a warning per unmatched sub-case
        for (const pt of conditionalProviderTransitions) {
          findings.push({
            kind: "unhandledProviderCase",
            boundary,
            provider: makeSide(provider, pt.id),
            consumer: makeSide(consumer),
            description: `Provider returns status ${status} in ${providerTransitions.length} different situations, and the consumer treats them all the same`,
            severity: "warning",
          });
        }
      }
      continue;
    }

    // Consumer has non-status predicates, try to match each provider
    // transition against consumer branches
    for (const pt of providerTransitions) {
      if (pt.isDefault || pt.conditions.length === 0) {
        continue;
      }

      const ptNonStatus = getNonStatusConditions(
        pt,
        statusAccessors,
        successAccessors,
      );
      if (ptNonStatus.length === 0) {
        continue;
      }

      // Check if any consumer non-status predicate matches this provider condition
      const matched = ptNonStatus.some((provPred) =>
        consumerNonStatusPredicates.some(
          (consPred) => predicatesMatch(provPred, consPred) === "match",
        ),
      );

      if (!matched) {
        // Check for opaque/unresolved: if either side is opaque, lowConfidence
        const hasOpaque = ptNonStatus.some((provPred) =>
          consumerNonStatusPredicates.some(
            (consPred) => predicatesMatch(provPred, consPred) === "unknown",
          ),
        );

        if (hasOpaque) {
          findings.push({
            kind: "lowConfidence",
            boundary,
            provider: makeSide(provider, pt.id),
            consumer: makeSide(consumer),
            description: `Provider returns status ${status} under a condition that could not be compared with the consumer's branches`,
            severity: "info",
          });
        }
        // If predicates are fully structured but don't match, that's expected,
        // provider conditions are about server-side values, consumer conditions
        // are about response fields. We don't emit a finding for this case;
        // cross-boundary body comparison (checkBodyCompatibility) handles the
        // field-level mismatch.
      }
    }
  }

  return findings;
}

/**
 * Extract conditions from a transition that are NOT status-code comparisons.
 * These are the conditions that distinguish sub-cases within a single status code.
 */
function getNonStatusConditions(
  t: Transition,
  accessors: StatusAccessors,
  successAccessors: StatusAccessors,
): Predicate[] {
  return t.conditions.filter(
    (p) => !isStatusPredicate(p, accessors, successAccessors),
  );
}

/**
 * Whether `p` says something about the response status rather than about
 * what came back in the body. A `!res.ok` guard reaches here as a
 * compound of two comparisons, which is why the range reader gets a say
 * and not only the two direct shapes below.
 */
function isStatusPredicate(
  p: Predicate,
  accessors: StatusAccessors,
  successAccessors: StatusAccessors,
): boolean {
  if (p.type === "comparison") {
    return (
      refLooksLikeStatus(p.left, accessors) ||
      refLooksLikeStatus(p.right, accessors)
    );
  }
  if (p.type === "negation") {
    return isStatusPredicate(p.operand, accessors, successAccessors);
  }
  return branchStatusRanges([p], accessors, successAccessors) !== null;
}
