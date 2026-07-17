import { BOUNDARY_ROLE } from "@suss/behavioral-ir";
import { boundaryKey } from "@suss/ir-core";

import type { BehavioralSummary } from "@suss/behavioral-ir";

// boundaryKey / normalizePath are shared comparison primitives owned by
// @suss/ir-core (the intent checker keys boundaries the same way). Kept
// re-exported here so the checker's internal modules and external
// consumers that import them from this module are unaffected by the move.
export { boundaryKey, normalizePath } from "@suss/ir-core";

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

export interface SummaryPair {
  provider: BehavioralSummary;
  consumer: BehavioralSummary;
  key: string;
}

export interface PairingResult {
  pairs: SummaryPair[];
  unmatched: {
    providers: BehavioralSummary[];
    consumers: BehavioralSummary[];
    noBinding: BehavioralSummary[];
  };
}

/**
 * Given a flat list of summaries, match providers to consumers by
 * `(method, normalizedPath)`.
 *
 * Each provider is paired with every matching consumer (N×M within a group).
 * Summaries without a boundary path end up in `unmatched.noBinding`.
 * Summaries with a path but no counterpart end up in the appropriate
 * `unmatched` bucket.
 */
export function pairSummaries(summaries: BehavioralSummary[]): PairingResult {
  const providersByKey = new Map<string, BehavioralSummary[]>();
  const consumersByKey = new Map<string, BehavioralSummary[]>();
  const noBinding: BehavioralSummary[] = [];

  for (const summary of summaries) {
    const binding = summary.identity.boundaryBinding;
    if (binding === null) {
      noBinding.push(summary);
      continue;
    }

    const key = boundaryKey(binding);
    if (key === null) {
      noBinding.push(summary);
      continue;
    }

    // Guard against summaries deserialized from disk with an unknown kind
    // string — the type system can't see those. Goes away once IR exposes
    // a real parser (see #79); until then, an unknown kind means we can't
    // place it on either side of a pairing.
    const role = BOUNDARY_ROLE[summary.kind];
    if (role === undefined) {
      noBinding.push(summary);
      continue;
    }
    const bucket = role === "provider" ? providersByKey : consumersByKey;
    const list = bucket.get(key);
    if (list !== undefined) {
      list.push(summary);
    } else {
      bucket.set(key, [summary]);
    }
  }

  const pairs: SummaryPair[] = [];
  const matchedProviderKeys = new Set<string>();
  const matchedConsumerKeys = new Set<string>();

  for (const [key, providers] of providersByKey) {
    const consumers = consumersByKey.get(key);
    if (consumers === undefined) {
      continue;
    }

    matchedProviderKeys.add(key);
    matchedConsumerKeys.add(key);

    for (const provider of providers) {
      for (const consumer of consumers) {
        pairs.push({ provider, consumer, key });
      }
    }
  }

  const unmatchedProviders: BehavioralSummary[] = [];
  for (const [key, providers] of providersByKey) {
    if (!matchedProviderKeys.has(key)) {
      unmatchedProviders.push(...providers);
    }
  }

  const unmatchedConsumers: BehavioralSummary[] = [];
  for (const [key, consumers] of consumersByKey) {
    if (!matchedConsumerKeys.has(key)) {
      unmatchedConsumers.push(...consumers);
    }
  }

  return {
    pairs,
    unmatched: {
      providers: unmatchedProviders,
      consumers: unmatchedConsumers,
      noBinding,
    },
  };
}
