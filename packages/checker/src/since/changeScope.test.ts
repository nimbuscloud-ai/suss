import { describe, expect, it } from "vitest";

import { restBinding } from "@suss/behavioral-ir";

import { provider, response, transition } from "../__fixtures__/pairs.js";
import { changeScope, changesWithin, touchedByChange } from "./changeScope.js";

import type {
  BehavioralSummary,
  Finding,
  Transition,
} from "@suss/behavioral-ir";

function route(name: string, transitions: Transition[]): BehavioralSummary {
  const summary = provider(name, transitions);
  return {
    ...summary,
    identity: {
      ...summary.identity,
      boundaryBinding: restBinding({
        transport: "http",
        recognition: "express",
        method: "POST",
        path: `/${name}`,
      }),
    },
  };
}

const created = transition("post:response:201:aaaaaaa", {
  output: response(201),
});
const duplicate = transition("post:response:409:ccccccc", {
  output: response(409),
});

function finding(
  name: string,
  status: number,
  extra: Partial<Finding> = {},
): Finding {
  return {
    kind: "unhandledProviderCase",
    boundary: restBinding({
      transport: "http",
      recognition: "express",
      method: "POST",
      path: `/${name}`,
    }),
    provider: {
      summary: `src/handlers/${name}.ts::${name}`,
      transitionId: `${name}:response:${status}:ccccccc`,
      location: {
        file: `src/handlers/${name}.ts`,
        range: { start: 1, end: 50 },
        exportName: name,
      },
    },
    consumer: {
      summary: "web/submit.ts::submit",
      location: {
        file: "web/submit.ts",
        range: { start: 1, end: 9 },
        exportName: "submit",
      },
    },
    description: `Provider produces status ${status} but no consumer branch handles it`,
    severity: "warning",
    ...extra,
  };
}

const NOTHING_MOVED = { summaries: [], findings: [] };

describe("touchedByChange", () => {
  it("matches a summary's file against a changed path that ends with it", () => {
    const scope = changeScope(
      NOTHING_MOVED,
      NOTHING_MOVED,
      ["services/api/src/handlers/orders.ts"],
      [],
    );

    expect(touchedByChange(finding("orders", 409), scope)).toEqual([
      "provider",
    ]);
  });

  it("matches whole path segments, so a longer file name is a different file", () => {
    const scope = changeScope(
      NOTHING_MOVED,
      NOTHING_MOVED,
      ["src/handlers/preorders.ts"],
      [],
    );

    expect(touchedByChange(finding("orders", 409), scope)).toEqual([]);
  });

  it("counts a unit whose behavior moved, though its file was not edited", () => {
    const before = [route("orders", [created])];
    const after = [route("orders", [created, duplicate])];
    const scope = changeScope(
      { summaries: before, findings: [] },
      { summaries: after, findings: [] },
      ["src/helpers/stock.ts"],
      [],
    );

    expect(touchedByChange(finding("orders", 409), scope)).toEqual([
      "provider",
    ]);
  });

  it("counts a finding at a boundary the code changed at, though neither side moved", () => {
    const scope = changeScope(
      NOTHING_MOVED,
      NOTHING_MOVED,
      [],
      ["POST /orders"],
    );

    expect(touchedByChange(finding("orders", 409), scope)).toEqual([
      "boundary",
    ]);
  });

  it("counts a merged finding by every summary behind its merged side", () => {
    const merged = finding("orders", 409, {
      sources: ["src/handlers/orders.ts::orders", "src/handlers/bulk.ts::bulk"],
    });
    const scope = changeScope(
      NOTHING_MOVED,
      NOTHING_MOVED,
      ["src/handlers/bulk.ts"],
      [],
    );

    expect(touchedByChange(merged, scope)).toEqual(["provider"]);
  });
});

describe("changesWithin", () => {
  it("keeps the new and resolved findings the change touched, and sets the rest apart", () => {
    const touched = finding("orders", 409);
    const untouched = finding("refunds", 409);
    const fixed = finding("orders", 410);
    const fixedElsewhere = finding("refunds", 410);

    const within = changesWithin(
      { summaries: [], findings: [fixed, fixedElsewhere] },
      { summaries: [], findings: [touched, untouched] },
      ["src/handlers/orders.ts"],
    );

    expect(within.added).toEqual([touched]);
    expect(within.addedElsewhere).toEqual([untouched]);
    expect(within.resolved).toEqual([fixed]);
    expect(within.resolvedElsewhere).toEqual([fixedElsewhere]);
    expect(within.changedFiles).toEqual(["src/handlers/orders.ts"]);
  });
});
