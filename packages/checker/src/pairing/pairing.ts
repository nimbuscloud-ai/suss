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

// The intent checker keys boundaries the same way, so these live in
// @suss/ir-core.
export { boundaryKey, normalizePath } from "@suss/ir-core";

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
     * build does not know. They share one list, and a reader groups them
     * by reason.
     */
    unpairable: UnpairableSummary[];
  };
  /**
   * Consumers whose path more than one service serves, with nothing to
   * show which one they call. Pairing with any of them could compare a
   * caller against another service's handler, so the run reports the
   * ambiguity instead.
   */
  ambiguous: AmbiguousPairing[];
}

/**
 * Whether two summaries in one bucket describe the same boundary.
 *
 * A bucket key contains only what both sides always record. Anything
 * one side records more precisely goes through the semantics variant's
 * own agreement rule: buses have to agree on a message-bus bucket, and
 * methods on a REST bucket. The method rule lets a `"*"` route meet
 * consumers that each use one method.
 */
function bindingsPair(
  provider: BehavioralSummary,
  consumer: BehavioralSummary,
): boolean {
  const providerSemantics = provider.identity.boundaryBinding?.semantics;
  const consumerSemantics = consumer.identity.boundaryBinding?.semantics;
  if (providerSemantics === undefined || consumerSemantics === undefined) {
    // A summary with no binding never gets a key, so only a direct call
    // lands here, and it pairs.
    return true;
  }

  return semanticsAgree(providerSemantics, consumerSemantics);
}

/**
 * The key a pair reports. The bucket key leaves out what the two sides
 * compare inside the bucket, so the pair uses the consumer's own key,
 * then the provider's, then the bucket's. A consumer of a `"*"` route
 * then shows the method it calls.
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
 * The providers a consumer's calls reach, out of the ones that agree
 * with it. Null when the run cannot tell.
 *
 * A client in one service calling another service's API is what this
 * check is for, so a provider elsewhere is a fine answer. The risk is
 * two services serving one path: pairing with both compares a client
 * against a handler it never calls, and reports a status nobody
 * returns and a field nobody sends. So a provider in the consumer's own
 * service wins, since a caller reaches its own service's route first.
 * With none there, one service serving the path is the answer, and
 * more than one is ambiguous.
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
    // A provider with no workspace is a declared document, such as this
    // service's OpenAPI file, so it stays beside the local provider and
    // the contract checks still run. `servicesOf` treats it the same way.
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
 * Match providers to consumers across a flat list of summaries.
 *
 * Summaries are bucketed by `pairingKey`, and `bindingsPair` settles
 * the rest, so each provider pairs with every agreeing consumer in its
 * bucket. A bucket whose key spans other keys, such as a route with a
 * hole that takes some number of segments, is compared with every
 * bucket on the other side through `bucketsMeet`, and the most specific
 * agreeing provider key wins. A summary that cannot take part goes in
 * `unmatched.unpairable` with the reason, and one with a key but no
 * agreeing counterpart goes in the matching `unmatched` list.
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

    // A summary read from disk can have a kind this build does not know,
    // and the types cannot rule that out. It belongs on neither side
    // (#79).
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
      // consumer reaches, and a tie is ambiguous.
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
