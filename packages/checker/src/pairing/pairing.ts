import { BOUNDARY_ROLE } from "@suss/behavioral-ir";
import {
  boundaryKey,
  bucketRank,
  bucketsMeet,
  compareRanks,
  semanticsAgree,
  spansBuckets,
} from "@suss/ir-core";

import { groundedKeys } from "./groundedPath.js";

import type { BehavioralSummary, BoundaryBinding } from "@suss/behavioral-ir";

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

/** One consumer, and the services that all serve what it calls. */
export interface AmbiguousPairing {
  consumer: BehavioralSummary;
  providers: BehavioralSummary[];
  services: string[];
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
  /**
   * Consumers whose path is served by more than one service, with
   * nothing saying which one they call. Pairing any of them would
   * compare a caller against a stranger's handler, so the run reports
   * the question instead.
   */
  ambiguous: AmbiguousPairing[];
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
 * The providers a consumer's calls actually reach, out of the ones that
 * agree with it. Null when the run cannot tell, which is a question
 * rather than a pair.
 *
 * One service's client calling another service's API is the case this
 * check exists for, so a provider elsewhere is a fine answer. Two
 * services serving the same path is the case that used to invent one:
 * every consumer paired with every provider, and a client that calls
 * its own service was compared against a stranger's handler, which
 * reported a status nobody returns and a field nobody sends.
 *
 * So a provider in the consumer's own service wins outright, since a
 * caller reaches its own service's route before anybody else's. With no
 * provider at home, one service serving the path is the answer, and
 * more than one is the question.
 */
function servedBy(
  consumer: BehavioralSummary,
  agreeing: BehavioralSummary[],
): BehavioralSummary[] | null {
  if (agreeing.length === 0) {
    return [];
  }
  const home = consumer.location.workspace;
  if (home !== undefined) {
    // A provider that states no workspace is a declared artifact rather
    // than a rival service, the way `servicesOf` below already treats
    // one, so it is kept beside the local provider instead of losing to
    // it. An OpenAPI document and the handler it describes are two
    // sides of one service, and dropping the document here is what
    // stopped the contract checks running at all.
    const athome = agreeing.filter(
      (provider) =>
        provider.location.workspace === home ||
        provider.location.workspace === undefined,
    );
    if (athome.length > 0) {
      return athome;
    }
  }
  return servicesOf(agreeing).length > 1 ? null : agreeing;
}

/**
 * The services a set of summaries states it came from. A summary that
 * states none is left out rather than counted as a service of its own:
 * a spec file describes an endpoint without saying who serves it, and
 * a single-project run labels nothing at all. Neither is a rival to
 * choose between.
 */
function servicesOf(summaries: readonly BehavioralSummary[]): string[] {
  const stated = summaries
    .map((summary) => summary.location.workspace)
    .filter((workspace): workspace is string => workspace !== undefined);
  return [...new Set(stated)].sort();
}

/** One side's summaries under one pairing key. */
interface Bucket {
  key: string;
  binding: BoundaryBinding;
  /** Whether this bucket meets buckets with other keys too. */
  spans: boolean;
  /** How narrowly the key states what it serves, from `bucketRank`. */
  rank: readonly number[];
  summaries: BehavioralSummary[];
}

/** The buckets that no other bucket in the list outranks. */
function highestRanked(buckets: Bucket[]): Bucket[] {
  let winners: Bucket[] = [];
  for (const bucket of buckets) {
    const first = winners[0];
    const order =
      first === undefined ? 1 : compareRanks(bucket.rank, first.rank);
    if (order > 0) {
      winners = [bucket];
    } else if (order === 0) {
      winners.push(bucket);
    }
  }
  return winners;
}

/**
 * Given a flat list of summaries, match providers to consumers.
 *
 * Summaries bucket on `pairingKey` and settle the rest with
 * `bindingsPair`; each provider pairs with every agreeing consumer in
 * its bucket (N×M within a group). A bucket whose key spans other keys
 * (a route with a hole that takes some number of segments) is compared
 * against every bucket on the other side with `bucketsMeet`, and the
 * most specific key among the providers that agree wins. Summaries that
 * cannot take part land in `unmatched.unpairable` with the reason;
 * sides with a key but no agreeing counterpart land in the matching
 * `unmatched` list.
 */
export function pairSummaries(summaries: BehavioralSummary[]): PairingResult {
  const providersByKey = new Map<string, Bucket>();
  const consumersByKey = new Map<string, Bucket>();
  const unpairable: UnpairableSummary[] = [];
  // A consumer whose base URL the deployment fills in buckets on the
  // path it reaches, so it meets the provider that serves it. What the
  // summary records is untouched.
  const keyOf = groundedKeys(summaries);

  for (const summary of summaries) {
    const binding = summary.identity.boundaryBinding;
    if (binding === null) {
      unpairable.push({ summary, reason: "noBoundary" });
      continue;
    }

    const grounded = keyOf(summary, binding);
    if (grounded === null) {
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
    const buckets = role === "provider" ? providersByKey : consumersByKey;
    const bucket = buckets.get(grounded.key);
    if (bucket !== undefined) {
      bucket.summaries.push(summary);
    } else {
      buckets.set(grounded.key, {
        key: grounded.key,
        binding: grounded.binding,
        spans: spansBuckets(grounded.binding),
        rank: bucketRank(grounded.binding),
        summaries: [summary],
      });
    }
  }
  const spanningProviders = [...providersByKey.values()].filter(
    (bucket) => bucket.spans,
  );

  const pairs: SummaryPair[] = [];
  /**
   * Tracked per summary rather than per key, because a key bucket can
   * contain a summary that pairs with nothing in it: two message-bus
   * sides share a subject but use different buses, or two REST sides
   * share a path but use different methods.
   */
  const matchedProviders = new Set<BehavioralSummary>();
  const matchedConsumers = new Set<BehavioralSummary>();

  const ambiguous: AmbiguousPairing[] = [];

  for (const consumers of consumersByKey.values()) {
    const exact = providersByKey.get(consumers.key);
    const meeting = (
      consumers.spans ? [...providersByKey.values()] : spanningProviders
    ).filter(
      (providers) =>
        providers.key !== consumers.key &&
        bucketsMeet(providers.binding, consumers.binding),
    );
    if (exact === undefined && meeting.length === 0) {
      continue;
    }

    for (const consumer of consumers.summaries) {
      const agreeing = [...(exact === undefined ? [] : [exact]), ...meeting]
        .map((providers) => ({
          ...providers,
          summaries: providers.summaries.filter((provider) =>
            bindingsPair(provider, consumer),
          ),
        }))
        .filter((providers) => providers.summaries.length > 0);
      if (agreeing.length === 0) {
        continue;
      }
      // A route with a hole spanning segments serves what a more exact
      // route serves too, so the highest ranked bucket is the one the
      // consumer reaches, and an even contest is a question.
      const winners = highestRanked(agreeing);
      const chosen =
        winners.length === 1
          ? servedBy(consumer, winners[0]?.summaries ?? [])
          : null;
      if (chosen === null) {
        const providers = winners.flatMap((providers) => providers.summaries);
        ambiguous.push({
          consumer,
          providers,
          services: servicesOf(providers),
        });
        continue;
      }

      for (const provider of chosen) {
        pairs.push({
          provider,
          consumer,
          key: pairKeyFor(provider, consumer, consumers.key),
        });
        matchedProviders.add(provider);
        matchedConsumers.add(consumer);
      }
    }
  }

  const unmatchedProviders: BehavioralSummary[] = [];
  for (const providers of providersByKey.values()) {
    for (const provider of providers.summaries) {
      if (!matchedProviders.has(provider)) {
        unmatchedProviders.push(provider);
      }
    }
  }

  const unmatchedConsumers: BehavioralSummary[] = [];
  for (const consumers of consumersByKey.values()) {
    for (const consumer of consumers.summaries) {
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
    ambiguous,
  };
}
