/**
 * The consumers that `check` pairs with a route or a GraphQL field, as
 * touches at that boundary.
 *
 * A client's binding is the request it makes, and `check` pairs it with
 * the route that serves the request even when the two spell the path
 * differently: a literal id where the route has a parameter, a base URL
 * the deployment fills in. A GraphQL operation's binding gives only its
 * type and name, `query Events`, and `check` reads its document to find
 * the root fields it selects. A question about who calls the route or
 * the field asks for those same pairs, through the checker's
 * `pairsWithProviders`, so `ask` and `check` agree on who calls it.
 */

import { bindingIs, OWN_BINDING, summaryIdentifier } from "@suss/behavioral-ir";
import {
  boundariesTouchedBy,
  boundarySpelling,
  pairsWithProviders,
} from "@suss/checker";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { TouchedBoundary } from "@suss/checker";

interface Touch {
  summary: BehavioralSummary;
  touched: TouchedBoundary;
}

/**
 * A touch for every consumer `check` pairs with a provider among these
 * touches. A REST client is at the request it makes, so its line says
 * the path it wrote. A GraphQL operation is at the field it selects,
 * with the operation as its callee.
 */
export function pairedTouchesAt(
  touches: ReadonlyArray<Touch>,
  summaries: ReadonlyArray<BehavioralSummary>,
): Touch[] {
  const provided = new Map<BehavioralSummary, TouchedBoundary>();
  for (const { summary, touched } of touches) {
    if (touched.relation === "provides") {
      provided.set(summary, touched);
    }
  }
  const found = new Map<string, Touch>();
  for (const { provider, consumer } of pairsWithProviders(
    new Set(provided.keys()),
    summaries,
  )) {
    const own = consumer.identity.boundaryBinding;
    const at = provided.get(provider);
    if (own === null || at === undefined) {
      continue;
    }
    for (const touch of consumerTouches(consumer, own, at)) {
      // A field the schema and the code both provide pairs twice.
      found.set(
        [
          summaryIdentifier(consumer),
          touch.touched.label,
          touch.touched.relation,
          touch.touched.callee ?? "",
        ].join("\u0000"),
        touch,
      );
    }
  }
  return [...found.values()];
}

function consumerTouches(
  consumer: BehavioralSummary,
  own: NonNullable<BehavioralSummary["identity"]["boundaryBinding"]>,
  provided: TouchedBoundary,
): Touch[] {
  if (bindingIs(provided.binding, "graphql-resolver")) {
    return OWN_BINDING.consumer(own).map((relation) => ({
      summary: consumer,
      touched: {
        label: provided.label,
        binding: provided.binding,
        relation,
        callee: boundarySpelling(own),
        detail: undefined,
        transitionId: undefined,
      },
    }));
  }
  const label = boundarySpelling(own);
  return boundariesTouchedBy(consumer)
    .filter(
      (touched) => touched.label === label && touched.relation !== "provides",
    )
    .map((touched) => ({ summary: consumer, touched }));
}
