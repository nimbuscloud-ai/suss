import { describe, expect, it } from "vitest";

import {
  contentByBoundary,
  contractsCoveredByAnother,
} from "./contractCopies.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

function getOrders(body: unknown, file: string): BehavioralSummary {
  return {
    kind: "handler",
    location: { file, range: { start: 0, end: 0 }, exportName: null },
    identity: {
      name: "list-orders",
      exportPath: null,
      boundaryBinding: {
        transport: "http",
        semantics: { name: "rest", method: "GET", path: "/orders" },
        recognition: "openapi",
      },
    },
    inputs: [],
    transitions: [
      {
        id: "list-orders:response:200",
        conditions: [],
        output: {
          type: "response",
          statusCode: { type: "literal", value: 200 },
          body,
          headers: {},
        },
        effects: [],
        location: { start: 0, end: 0 },
        isDefault: false,
      },
    ],
    gaps: [],
    confidence: { source: "stub", level: "high" },
  } as unknown as BehavioralSummary;
}

const text = { type: "text" };
const number = { type: "number" };
const nothing = { type: "undefined" };

describe("contractsCoveredByAnother", () => {
  it("takes a union inside a union to say the same as one union", () => {
    const source = { name: "openapi", file: "spec/index.yaml" };
    const bundle = { name: "openapi", file: "spec/bundle.yaml" };
    const flat = contentByBoundary([
      getOrders(
        { type: "union", variants: [text, number, nothing] },
        "spec/index.yaml",
      ),
    ]);
    const nested = contentByBoundary([
      getOrders(
        {
          type: "union",
          variants: [{ type: "union", variants: [text, number] }, nothing],
        },
        "spec/bundle.yaml",
      ),
    ]);

    const covered = contractsCoveredByAnother(
      "/nowhere",
      new Map([
        [source, flat],
        [bundle, nested],
      ]),
    );

    // Neither file is on disk, so neither is smaller and the name decides.
    expect(covered).toEqual([
      { suggestion: source, coveredBy: "spec/bundle.yaml" },
    ]);
  });

  it("leaves a file it cannot key out of the comparison", () => {
    const summary = getOrders(text, "spec/index.yaml");
    summary.identity.boundaryBinding = null;

    expect(contentByBoundary([summary])).toBeNull();
  });
});
