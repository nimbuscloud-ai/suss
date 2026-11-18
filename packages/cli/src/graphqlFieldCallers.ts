/**
 * The GraphQL client operations that `check` pairs with a field, as
 * touches at that field.
 *
 * An operation's binding gives only its type and name, `query Events`.
 * `check` reads the operation's document to find the root fields it
 * selects, and pairs it with the resolvers that serve them. A question
 * about `gql:Query.events` asks for those same pairs, so an operation
 * that selects the field is listed as calling it, and `ask` and `check`
 * agree on who calls a field.
 */

import { bindingIs, OWN_BINDING, summaryIdentifier } from "@suss/behavioral-ir";
import { pairGraphqlOperations, productionCode } from "@suss/checker";

import { boundarySpelling } from "./boundaryReach.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { TouchedBoundary } from "./boundaryReach.js";

interface Touch {
  summary: BehavioralSummary;
  touched: TouchedBoundary;
}

type Pairs = ReturnType<typeof pairGraphqlOperations>["pairs"];

// One question resolves a target and grounds its touches over the same
// summaries, and each would otherwise parse every operation again.
const pairsBySummaries = new WeakMap<ReadonlyArray<BehavioralSummary>, Pairs>();

function graphqlPairsIn(summaries: ReadonlyArray<BehavioralSummary>): Pairs {
  const known = pairsBySummaries.get(summaries);
  if (known !== undefined) {
    return known;
  }
  const pairs = pairGraphqlOperations(productionCode(summaries)).pairs;
  pairsBySummaries.set(summaries, pairs);
  return pairs;
}

/**
 * A touch at each field these touches provide, for every operation that
 * `check` pairs with the field's resolver. The touch has the field's
 * label and binding, and the operation as its callee.
 */
export function operationTouchesAt(
  touches: ReadonlyArray<Touch>,
  summaries: ReadonlyArray<BehavioralSummary>,
): Touch[] {
  const fields = new Map<BehavioralSummary, TouchedBoundary>();
  for (const { summary, touched } of touches) {
    if (
      touched.relation === "provides" &&
      bindingIs(touched.binding, "graphql-resolver")
    ) {
      fields.set(summary, touched);
    }
  }
  if (fields.size === 0) {
    return [];
  }
  const found = new Map<string, Touch>();
  for (const { provider, consumer } of graphqlPairsIn(summaries)) {
    const field = fields.get(provider);
    const own = consumer.identity.boundaryBinding;
    if (field === undefined || own === null) {
      continue;
    }
    for (const relation of OWN_BINDING.consumer(own)) {
      const touched: TouchedBoundary = {
        label: field.label,
        binding: field.binding,
        relation,
        callee: boundarySpelling(own),
        detail: undefined,
        transitionId: undefined,
      };
      // A field the schema and the code both provide pairs twice.
      found.set(
        [summaryIdentifier(consumer), field.label, relation].join("\u0000"),
        { summary: consumer, touched },
      );
    }
  }
  return [...found.values()];
}
