import { describe, expect, it } from "vitest";

import {
  functionCallBinding,
  restBinding,
  storageBinding,
} from "@suss/behavioral-ir";

import { functionOf, readCallFacts } from "../calls/callFacts.js";
import {
  reachTargetOfTouches,
  reachTargetOfUnits,
  representativeUnit,
} from "./reachTarget.js";
import { providesKeyOf, touchesOfUnits, unitsServing } from "./touches.js";

import type { BehavioralSummary, Effect } from "@suss/behavioral-ir";

function unit(
  name: string,
  kind: BehavioralSummary["kind"],
  binding: BehavioralSummary["identity"]["boundaryBinding"],
  effects: Effect[] = [],
  line = 1,
): BehavioralSummary {
  return {
    kind,
    location: {
      file: "src/orders.ts",
      range: { start: line, end: line + 4 },
      exportName: name,
    },
    identity: {
      name,
      exportPath: [name],
      boundaryBinding: binding,
      id: `src/orders.ts::${name}`,
    },
    inputs: [],
    transitions: [
      {
        id: `${name}:1`,
        conditions: [],
        output: { type: "return", value: null },
        effects,
        location: { start: line, end: line + 4 },
        isDefault: true,
      },
    ],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

const exported = functionCallBinding({
  transport: "in-process",
  recognition: "package-exports",
  package: "@shop/orders",
  exportPath: ["listOrders"],
});

const table = storageBinding({
  recognition: "prisma",
  storageSystem: "postgresql",
  scope: "default",
  container: "orders",
});

describe("reach targets", () => {
  it("takes a provider's export as a key callers can be bound to", () => {
    const provider = unit("listOrders", "library", exported);
    expect(reachTargetOfUnits([provider])).toEqual({
      functions: [functionOf(provider)],
      keys: ["fn:@shop/orders::listOrders"],
    });
  });

  it("puts a unit that touches a boundary at it, and a provider in front of it", () => {
    const route = unit(
      "GET /orders",
      "handler",
      restBinding({
        transport: "http",
        method: "GET",
        path: "/orders",
        recognition: "express",
      }),
      [],
      1,
    );
    const reader = unit(
      "readOrders",
      "library",
      null,
      [
        {
          type: "interaction",
          binding: table,
          interaction: {
            class: "storage-access",
            kind: "read",
            fields: ["id"],
          },
        },
      ],
      10,
    );
    const touches = touchesOfUnits([route, reader]);
    const atTable = touches.filter((touch) => touch.touched.binding === table);
    // A store has no export key; its callers are placed by where they touch it.
    expect(reachTargetOfTouches(atTable)).toEqual({
      functions: [],
      keys: [],
      at: [functionOf(reader)],
    });
    expect(unitsServing(touches)).toEqual([route]);
    expect(providesKeyOf(route)).toBe("GET /orders");
    expect(providesKeyOf(reader)).toBeUndefined();
  });

  it("prints a function as its provider summary when it has one", () => {
    const library = unit("listOrders", "library", null, [], 20);
    const provider = unit("listOrders", "handler", exported, [], 20);
    const facts = readCallFacts([library, provider]);
    expect(representativeUnit(facts, functionOf(library))).toBe(provider);
    expect(() => representativeUnit(facts, "nowhere")).toThrow(
      "no summary for function nowhere",
    );
  });
});
