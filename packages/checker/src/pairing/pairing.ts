import { BOUNDARY_ROLE } from "@suss/behavioral-ir";
import {
  boundaryKey,
  bucketsMeet,
  compareRanks,
  exchangesHttpResponses,
  pairRank,
  semanticsAgree,
  spansBuckets,
} from "@suss/ir-core";

import { isContractDocument } from "../contract/declaredContract.js";
import { groundedKeys } from "./groundedPath.js";
import { isTestCode } from "./testCode.js";

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
export type UnpairableReason =
  | "noBoundary"
  | "unnamedBoundary"
  | "unknownKind"
  | "testCode";

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
     * build does not know, and `testCode` is a test or code in a test
     * file. They share one list, and a reader groups them by reason.
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
 * consumers that each use one method. Both bindings are the ones the
 * deployment grounded, so a host it treats as the app's own is gone.
 */
function bindingsPair(
  provider: BoundaryBinding,
  consumer: BoundaryBinding,
): boolean {
  return semanticsAgree(provider.semantics, consumer.semantics);
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
export function servicesOf(summaries: readonly BehavioralSummary[]): string[] {
  const stated = summaries
    .map((summary) => summary.location.workspace)
    .filter((workspace): workspace is string => workspace !== undefined);
  return [...new Set(stated)].sort();
}

/**
 * Whether the providers a consumer reaches are routes in more than one
 * function, all equally specific. One request reaches one handler, so
 * when `/:username/:view` and `/:feed_type/:timeframe` both match
 * `/admin/stats`, the framework picks by the order it was given, which
 * the run cannot see. A contract document describes a route and serves
 * nothing, so it is never a rival.
 */
function routesTie(providers: readonly BehavioralSummary[]): boolean {
  const functions = new Set(
    providers
      .filter(
        (provider) =>
          servesOneRequestAlone(provider) &&
          provider.identity.boundaryBinding !== null &&
          exchangesHttpResponses(provider.identity.boundaryBinding) &&
          !isContractDocument(provider),
      )
      .map(servingFunction),
  );
  return functions.size > 1;
}

/**
 * Whether a server picks this unit alone for a request. A client-side
 * router renders a layout and its index route together at one URL, and
 * runs every matching loader, so components and loaders never tie.
 */
function servesOneRequestAlone(provider: BehavioralSummary): boolean {
  return provider.kind === "handler";
}

/**
 * The function a summary describes. Two summaries of one function, one
 * per route it is registered under, give the same answer.
 */
export function servingFunction({ location }: BehavioralSummary): string {
  return `${location.workspace ?? ""}|${location.file}:${location.range.start}`;
}

/** One side's summaries under one pairing key. */
interface Bucket {
  key: string;
  binding: BoundaryBinding;
  /** Whether this bucket meets buckets with other keys too. */
  spans: boolean;
  summaries: BehavioralSummary[];
}

/** A provider bucket, ranked by how well it fits one consumer's call. */
interface RankedBucket extends Bucket {
  rank: readonly number[];
}

/** The buckets that no other bucket in the list outranks. */
function highestRanked(buckets: RankedBucket[]): RankedBucket[] {
  let winners: RankedBucket[] = [];
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
  const groundedBinding = new Map<BehavioralSummary, BoundaryBinding>();

  for (const summary of summaries) {
    const binding = summary.identity.boundaryBinding;
    if (binding === null) {
      unpairable.push({ summary, reason: "noBoundary" });
      continue;
    }

    if (isTestCode(summary)) {
      unpairable.push({ summary, reason: "testCode" });
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
    groundedBinding.set(summary, grounded.binding);
    const buckets = role === "provider" ? providersByKey : consumersByKey;
    const bucket = buckets.get(grounded.key);
    if (bucket !== undefined) {
      bucket.summaries.push(summary);
    } else {
      buckets.set(grounded.key, {
        key: grounded.key,
        binding: grounded.binding,
        spans: spansBuckets(grounded.binding),
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
      const called = groundedBinding.get(consumer) ?? consumers.binding;
      const agreeing: RankedBucket[] = [];
      for (const providers of [
        ...(exact === undefined ? [] : [exact]),
        ...meeting,
      ]) {
        const rank = pairRank(providers.binding, called);
        // Summaries share a bucket by path shape alone, so one in a bucket
        // that meets the call can still serve none of it, as a spec for
        // `/search` does not serve the `/search.json` a route also takes.
        const summaries = providers.summaries.filter((provider) => {
          const binding = groundedBinding.get(provider) ?? providers.binding;
          return (
            bindingsPair(binding, called) &&
            (providers === exact || bucketsMeet(binding, called))
          );
        });
        if (rank !== null && summaries.length > 0) {
          agreeing.push({ ...providers, rank, summaries });
        }
      }
      if (agreeing.length === 0) {
        continue;
      }
      // The highest ranked buckets are the ones the consumer reaches. A
      // tie across buckets is judged as one bucket is, so a spec still
      // pairs beside the handler it describes.
      const winners = highestRanked(agreeing);
      const providers = winners.flatMap((bucket) => bucket.summaries);
      const chosen = servedBy(consumer, providers);
      if (chosen === null || routesTie(chosen)) {
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
