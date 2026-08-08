import { BOUNDARY_ROLE } from "@suss/behavioral-ir";
import { boundaryKey, pairingKey, semanticsAgree } from "@suss/ir-core";

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

/** Why a summary took no part in pairing. */
export type UnpairableReason = "noBoundary" | "unnamedBoundary" | "unknownKind";

export interface UnpairableSummary {
  summary: BehavioralSummary;
  reason: UnpairableReason;
}

export interface PairingResult {
  pairs: SummaryPair[];
  unmatched: {
    providers: BehavioralSummary[];
    consumers: BehavioralSummary[];
    /**
     * Summaries that took no part in pairing, each with the reason.
     * `noBoundary` is internal code with nothing to pair on,
     * `unnamedBoundary` is a boundary the source never gave a name to,
     * and `unknownKind` is a summary read from disk with a kind this
     * build does not know. One list, so a caller walks it once, and the
     * reason is what a reader groups by.
     */
    unpairable: UnpairableSummary[];
  };
}

/**
 * Whether two summaries that share a bucket are really the same
 * boundary.
 *
 * A bucket key contains only what both sides always know. Anything one
 * side knows more precisely is settled by the semantics variant's own
 * agreement rule: buses have to agree on a message-bus bucket, methods
 * on a REST bucket (which is how a `"*"` route meets consumers that
 * each use one method).
 */
function bindingsPair(
  provider: BehavioralSummary,
  consumer: BehavioralSummary,
): boolean {
  const providerSemantics = provider.identity.boundaryBinding?.semantics;
  const consumerSemantics = consumer.identity.boundaryBinding?.semantics;
  if (providerSemantics === undefined || consumerSemantics === undefined) {
    // Unreachable from a bucket: a summary with no binding never got
    // a key. Kept permissive so a direct caller sees old behavior.
    return true;
  }

  return semanticsAgree(providerSemantics, consumerSemantics);
}

/**
 * The key a pair reports. The bucket key drops what the sides compare
 * in-bucket, so the pair uses the consumer's concrete identity (a
 * consumer of a `"*"` route shows the method it actually uses),
 * falling back to the provider's, then to the bucket.
 */
function pairKeyFor(
  provider: BehavioralSummary,
  consumer: BehavioralSummary,
  bucketKey: string,
): string {
  const consumerBinding = consumer.identity.boundaryBinding;
  const providerBinding = provider.identity.boundaryBinding;
  const consumerKey =
    consumerBinding === null ? null : boundaryKey(consumerBinding);
  if (consumerKey !== null) {
    return consumerKey;
  }

  const providerKey =
    providerBinding === null ? null : boundaryKey(providerBinding);
  return providerKey ?? bucketKey;
}

/**
 * Given a flat list of summaries, match providers to consumers.
 *
 * Summaries bucket on `pairingKey` and settle the rest with
 * `bindingsPair`; each provider pairs with every agreeing consumer in
 * its bucket (N×M within a group). Summaries that cannot take part
 * land in `unmatched.unpairable` with the reason; sides with a key but
 * no agreeing counterpart land in the matching `unmatched` list.
 */
export function pairSummaries(summaries: BehavioralSummary[]): PairingResult {
  const providersByKey = new Map<string, BehavioralSummary[]>();
  const consumersByKey = new Map<string, BehavioralSummary[]>();
  const unpairable: UnpairableSummary[] = [];

  for (const summary of summaries) {
    const binding = summary.identity.boundaryBinding;
    if (binding === null) {
      unpairable.push({ summary, reason: "noBoundary" });
      continue;
    }

    const key = pairingKey(binding);
    if (key === null) {
      unpairable.push({ summary, reason: "unnamedBoundary" });
      continue;
    }

    // Guard against summaries deserialized from disk with an unknown kind
    // string: the type system can't see those. Goes away once IR exposes
    // a real parser (see #79); until then, an unknown kind means we can't
    // place it on either side of a pairing.
    const role = BOUNDARY_ROLE[summary.kind];
    if (role === undefined) {
      unpairable.push({ summary, reason: "unknownKind" });
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
  /**
   * Tracked per summary rather than per key, because a key bucket can
   * contain a summary that pairs with nothing in it: two message-bus
   * sides share a subject but use different buses, or two REST sides
   * share a path but use different methods.
   */
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
        pairs.push({
          provider,
          consumer,
          key: pairKeyFor(provider, consumer, key),
        });
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
      unpairable,
    },
  };
}
