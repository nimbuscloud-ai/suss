import { predicatesMatch } from "./match.js";
import {
  consumerExpectedStatuses,
  extractResponseStatus,
  hasOpaqueStatus,
  makeBoundary,
  makeSide,
} from "./response-match.js";

import type {
  BehavioralSummary,
  Finding,
  Predicate,
  Transition,
  ValueRef,
} from "@suss/behavioral-ir";

export function checkProviderCoverage(
  provider: BehavioralSummary,
  consumer: BehavioralSummary,
): Finding[] {
  const findings: Finding[] = [];
  const boundary = makeBoundary(provider, consumer);

  const consumerStatuses = new Set<number>();
  let consumerHasDefault = false;
  for (const ct of consumer.transitions) {
    if (ct.isDefault) {
      consumerHasDefault = true;
    }
    for (const s of consumerExpectedStatuses(ct)) {
      consumerStatuses.add(s);
    }
  }

  // Group provider transitions by status code for sub-case analysis
  const providerByStatus = new Map<number, Transition[]>();

  for (const pt of provider.transitions) {
    if (hasOpaqueStatus(pt)) {
      findings.push({
        kind: "lowConfidence",
        boundary,
        provider: makeSide(provider, pt.id),
        consumer: makeSide(consumer),
        description: `Provider transition ${pt.id} has an opaque status code; coverage cannot be verified`,
        severity: "info",
      });
      continue;
    }

    const status = extractResponseStatus(pt);
    if (status == null) {
      continue;
    }

    if (
      !consumerStatuses.has(status) &&
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

    // Status is covered — track for sub-case analysis
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
    const consumerForStatus = consumer.transitions.filter((ct) => {
      if (ct.isDefault && isSuccessStatus(status)) {
        return true;
      }
      return consumerExpectedStatuses(ct).includes(status);
    });

    // Extract non-status predicates from consumer transitions (the conditions
    // beyond "status === N" that distinguish sub-cases)
    const consumerNonStatusPredicates = consumerForStatus.flatMap((ct) =>
      getNonStatusConditions(ct),
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
        // doesn't distinguish — emit a warning per unmatched sub-case
        for (const pt of conditionalProviderTransitions) {
          findings.push({
            kind: "unhandledProviderCase",
            boundary,
            provider: makeSide(provider, pt.id),
            consumer: makeSide(consumer),
            description: `Provider has ${providerTransitions.length} distinct cases for status ${status} but consumer does not distinguish between them (transition ${pt.id} has conditions the consumer ignores)`,
            severity: "warning",
          });
        }
      }
      continue;
    }

    // Consumer has non-status predicates — try to match each provider
    // transition against consumer branches
    for (const pt of providerTransitions) {
      if (pt.isDefault || pt.conditions.length === 0) {
        continue;
      }

      const ptNonStatus = getNonStatusConditions(pt);
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
        // Check for opaque/unresolved — if either side is opaque, lowConfidence
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
            description: `Provider transition ${pt.id} for status ${status} has conditions that cannot be verified against consumer predicates`,
            severity: "info",
          });
        }
        // If predicates are fully structured but don't match, that's expected —
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
function getNonStatusConditions(t: Transition): Predicate[] {
  return t.conditions.filter((p) => !isStatusPredicate(p));
}

function isStatusPredicate(p: Predicate): boolean {
  if (p.type === "comparison") {
    return isStatusRef(p.left) || isStatusRef(p.right);
  }
  if (p.type === "negation") {
    return isStatusPredicate(p.operand);
  }
  return false;
}

function isStatusRef(v: ValueRef): boolean {
  if (v.type === "derived" && v.derivation.type === "propertyAccess") {
    return (
      v.derivation.property === "status" ||
      v.derivation.property === "statusCode"
    );
  }
  if (v.type === "input") {
    const last = v.path[v.path.length - 1];
    return last === "status" || last === "statusCode";
  }
  return false;
}

function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}
