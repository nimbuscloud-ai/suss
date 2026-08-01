import { BOUNDARY_ROLE } from "@suss/behavioral-ir";
import { boundaryKey, channelsPair } from "@suss/ir-core";

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
 * Whether two summaries that share a key really name the same
 * boundary.
 *
 * A key is usually the whole answer, but a message-bus key carries
 * only the subject so that `default#order.placed` and `order.placed`
 * land in one bucket. The bus is compared here instead, where a side
 * that names its bus can still pair with a side that cannot know one,
 * and two named buses have to agree.
 */
function bindingsPair(
  provider: BehavioralSummary,
  consumer: BehavioralSummary,
): boolean {
  const providerSemantics = provider.identity.boundaryBinding?.semantics;
  const consumerSemantics = consumer.identity.boundaryBinding?.semantics;
  if (
    providerSemantics?.name === "message-bus" &&
    consumerSemantics?.name === "message-bus"
  ) {
    return channelsPair(providerSemantics.channel, consumerSemantics.channel);
  }
  return true;
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
  // Tracked per summary rather than per key, because a key bucket can
  // now hold a summary that pairs with nothing in it: two message-bus
  // sides share a subject but name different buses.
  const matchedProviders = new Set<BehavioralSummary>();
  const matchedConsumers = new Set<BehavioralSummary>();

  for (const [key, providers] of providersByKey) {
    const consumers = consumersByKey.get(key);
    if (consumers === undefined) {
      continue;
    }

    for (const provider of providers) {
      for (const consumer of consumers) {
        if (!bindingsPair(provider, consumer)) {
          continue;
        }
        pairs.push({ provider, consumer, key });
        matchedProviders.add(provider);
        matchedConsumers.add(consumer);
      }
    }
  }

  const unmatchedProviders: BehavioralSummary[] = [];
  for (const providers of providersByKey.values()) {
    for (const provider of providers) {
      if (!matchedProviders.has(provider)) {
        unmatchedProviders.push(provider);
      }
    }
  }

  const unmatchedConsumers: BehavioralSummary[] = [];
  for (const consumers of consumersByKey.values()) {
    for (const consumer of consumers) {
      if (!matchedConsumers.has(consumer)) {
        unmatchedConsumers.push(consumer);
      }
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
