import { describe, expect, it } from "vitest";

import { restBinding, storageBinding } from "@suss/behavioral-ir";

import { reachChanges } from "./diffReach.js";

import type { BehavioralSummary, Effect } from "@suss/behavioral-ir";

const CONFIDENT = { source: "inferred_static", level: "high" } as const;

/** A read of one table, as a pack records it. */
function readsOrders(): Effect {
  return {
    type: "interaction",
    binding: storageBinding({
      recognition: "aws-dynamodb-query",
      storageSystem: "aws.dynamodb",
      scope: "default",
      container: "orders",
    }),
    callee: "docClient.query",
    interaction: {
      class: "storage-access",
      kind: "read",
      fields: ["orderId"],
      selector: ["orderId"],
      operation: "query",
    },
  };
}

function calls(callee: string, target: string): Effect {
  return { type: "invocation", callee, args: [], async: true, summary: target };
}

/** A function somewhere in the project, with whatever it does in one transition. */
function unit(
  name: string,
  file: string,
  effects: Effect[],
  line = 1,
): BehavioralSummary {
  return {
    kind: "library",
    location: {
      file,
      range: { start: line, end: line + 10 },
      exportName: name,
    },
    identity: {
      name,
      exportPath: [name],
      boundaryBinding: null,
      id: `test::${file}::${name}`,
    },
    inputs: [],
    transitions: [
      {
        id: `${name}:1`,
        conditions: [],
        output: { type: "return", value: null },
        effects,
        location: { start: line, end: line + 5 },
        isDefault: true,
      },
    ],
    gaps: [],
    confidence: CONFIDENT,
  };
}

/** The route requests come in at. */
function route(effects: Effect[]): BehavioralSummary {
  return {
    ...unit("show", "src/routes.ts", effects, 100),
    kind: "handler",
    identity: {
      name: "show",
      exportPath: ["show"],
      boundaryBinding: restBinding({
        transport: "http",
        recognition: "express",
        method: "GET",
        path: "/orders/{id}",
      }),
      id: "test::src/routes.ts::show",
    },
  };
}

const CALLS_STORE = calls("loadOrder", "test::src/store.ts::loadOrder");
const CALLS_ROW = calls("readRow", "test::src/row.ts::readRow");

describe("what a boundary reaches, between two runs", () => {
  it("reports a table a route now reads through the function it calls", () => {
    const before = [
      route([CALLS_STORE]),
      unit("loadOrder", "src/store.ts", []),
    ];
    const after = [
      route([CALLS_STORE]),
      unit("loadOrder", "src/store.ts", [readsOrders()]),
    ];

    const [change] = reachChanges(before, after);

    expect(change?.boundary).toBe("GET /orders/{id}");
    expect(change?.gained).toEqual([
      {
        relation: "reads",
        label: "aws.dynamodb:orders",
        through: ["loadOrder"],
      },
    ]);
    expect(change?.lost).toEqual([]);
  });

  it("reports a table a route stopped reading", () => {
    const before = [
      route([CALLS_STORE]),
      unit("loadOrder", "src/store.ts", [readsOrders()]),
    ];
    const after = [route([CALLS_STORE]), unit("loadOrder", "src/store.ts", [])];

    const [change] = reachChanges(before, after);

    expect(change?.lost.map((effect) => effect.label)).toEqual([
      "aws.dynamodb:orders",
    ]);
  });

  it("keeps every call it took to get there", () => {
    const before = [
      route([CALLS_STORE]),
      unit("loadOrder", "src/store.ts", [CALLS_ROW]),
      unit("readRow", "src/row.ts", []),
    ];
    const after = [
      route([CALLS_STORE]),
      unit("loadOrder", "src/store.ts", [CALLS_ROW]),
      unit("readRow", "src/row.ts", [readsOrders()]),
    ];

    const [change] = reachChanges(before, after);

    expect(change?.gained[0]?.through).toEqual(["loadOrder", "readRow"]);
  });

  it("says nothing about a route whose reach is the same on both sides", () => {
    const summaries = [
      route([CALLS_STORE]),
      unit("loadOrder", "src/store.ts", [readsOrders()]),
    ];

    expect(reachChanges(summaries, summaries)).toEqual([]);
  });

  it("marks a route that is new as added, with everything it reaches", () => {
    const after = [
      route([CALLS_STORE]),
      unit("loadOrder", "src/store.ts", [readsOrders()]),
    ];

    const [change] = reachChanges([], after);

    expect(change?.change).toBe("added");
    expect(change?.gained.map((effect) => effect.label)).toEqual([
      "aws.dynamodb:orders",
    ]);
  });

  it("leaves the boundary a route serves out of what it reaches", () => {
    const after = [route([])];

    expect(reachChanges([], after)).toEqual([]);
  });
});
