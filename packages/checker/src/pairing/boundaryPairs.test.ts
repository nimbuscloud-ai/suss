import { describe, expect, it } from "vitest";

import { restBinding, summaryIdentifier } from "@suss/behavioral-ir";

import { consumerWithPath, providerWithPath } from "../__fixtures__/pairs.js";
import { checkAll } from "../index.js";
import { pairsWithProviders } from "./boundaryPairs.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

/** A Rails route, which serves its path with a format after it too. */
function railsRoute(name: string, path: string): BehavioralSummary {
  const base = providerWithPath(name, "GET", path);
  return {
    ...base,
    identity: {
      ...base.identity,
      boundaryBinding: restBinding({
        transport: "http",
        method: "GET",
        path,
        recognition: "rails",
        optionalFormat: true,
      }),
    },
  };
}

describe("pairsWithProviders", () => {
  const search = railsRoute("search", "/search");
  const reports = railsRoute("reports", "/search/reports");
  const plain = consumerWithPath("plain", "GET", "/search");
  const json = consumerWithPath("json", "GET", "/search.json");
  const nested = consumerWithPath("nested", "GET", "/search/reports");
  const summaries = [search, reports, plain, json, nested];

  it("gives the clients pairing puts with the route, whatever path each wrote", () => {
    expect(
      pairsWithProviders(new Set([search]), summaries).map(
        (pair) => pair.consumer,
      ),
    ).toEqual([plain, json]);
  });

  it("gives the same pairs `checkAll` compares", () => {
    const checked = checkAll(summaries)
      .pairs.filter((pair) => pair.provider === summaryIdentifier(search))
      .map((pair) => pair.consumer);

    expect(
      pairsWithProviders(new Set([search]), summaries).map((pair) =>
        summaryIdentifier(pair.consumer),
      ),
    ).toEqual(checked);
  });

  it("gives nothing for no providers", () => {
    expect(pairsWithProviders(new Set(), summaries)).toEqual([]);
  });
});
