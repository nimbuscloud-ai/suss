/**
 * Which consumer `check` compares with which provider, for the protocols
 * that pair one summary with another: REST, and a GraphQL operation with
 * the resolvers of the fields it selects.
 *
 * `checkAll` reads its pairs here, and so does `suss ask` when it lists
 * who calls a route or a field. A question about a boundary's callers
 * and a check of that boundary then list the same consumers, however
 * either side spells its path.
 */

import { pairGraphqlOperations } from "./graphqlPairing.js";
import { pairSummaries } from "./pairing.js";
import { productionCode } from "./testCode.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { GraphqlPairingResult } from "./graphqlPairing.js";
import type { PairingResult, SummaryPair } from "./pairing.js";

export interface BoundaryPairs {
  rest: PairingResult;
  graphql: GraphqlPairingResult;
}

export function pairBoundaries(summaries: BehavioralSummary[]): BoundaryPairs {
  return {
    rest: pairSummaries(summaries),
    // REST pairing lists test code as unpairable, and every other pass
    // leaves it out the same way.
    graphql: pairGraphqlOperations(productionCode(summaries)),
  };
}

// A question resolves its subject and then lists the units at it, and
// each step would otherwise pair the whole run again.
const pairsBySummaries = new WeakMap<
  ReadonlyArray<BehavioralSummary>,
  readonly SummaryPair[]
>();

function comparedPairs(
  summaries: ReadonlyArray<BehavioralSummary>,
): readonly SummaryPair[] {
  const known = pairsBySummaries.get(summaries);
  if (known !== undefined) {
    return known;
  }
  const { rest, graphql } = pairBoundaries([...summaries]);
  const pairs = [...rest.pairs, ...graphql.pairs];
  pairsBySummaries.set(summaries, pairs);
  return pairs;
}

/** Every pair `check` compares over these summaries whose provider is one of the given ones. */
export function pairsWithProviders(
  providers: ReadonlySet<BehavioralSummary>,
  summaries: ReadonlyArray<BehavioralSummary>,
): SummaryPair[] {
  if (providers.size === 0) {
    return [];
  }
  return comparedPairs(summaries).filter((pair) =>
    providers.has(pair.provider),
  );
}
