import { describe, expect, it } from "vitest";

import { withWrapperMetadata } from "@suss/behavioral-ir";

import { callSpellings, functionOf, readCallFacts } from "./callFacts.js";

import type {
  BehavioralSummary,
  BoundaryBinding,
  Effect,
} from "@suss/behavioral-ir";

function unit(
  name: string,
  effects: Effect[] = [],
  line = 1,
  file = `src/${name}.ts`,
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
    confidence: { source: "inferred_static", level: "high" },
  };
}

function calls(
  callee: string,
  target?: BehavioralSummary,
  extra: Partial<Extract<Effect, { type: "invocation" }>> = {},
): Effect {
  return {
    type: "invocation",
    callee,
    args: [],
    async: false,
    ...(target === undefined ? {} : { summary: target.identity.id }),
    ...extra,
  };
}

const EXPORT: BoundaryBinding = {
  transport: "in-process",
  semantics: {
    name: "function-call",
    package: "@demo/orders",
    exportPath: ["loadOrder"],
  },
  recognition: "package-exports",
};

function boundTo(
  summary: BehavioralSummary,
  kind: "library" | "caller",
): BehavioralSummary {
  return {
    ...summary,
    kind,
    identity: { ...summary.identity, boundaryBinding: EXPORT },
  };
}

describe("readCallFacts", () => {
  const store = unit("loadOrder");
  const service = unit("orderService", [calls("loadOrder", store)]);
  const route = unit("showOrder", [calls("orderService", service)]);

  it("keys a function by where it is, so every summary of it is one node", () => {
    const facts = readCallFacts([
      store,
      { ...store, identity: { ...store.identity, id: "other" } },
    ]);
    expect(facts.units.get(functionOf(store))).toHaveLength(2);
  });

  it("lists every call from one function to another", () => {
    const edges = readCallFacts([store, service, route]).edges();
    expect(edges).toEqual(
      expect.arrayContaining([
        {
          from: functionOf(service),
          to: functionOf(store),
          callee: "loadOrder",
        },
        {
          from: functionOf(route),
          to: functionOf(service),
          callee: "orderService",
        },
      ]),
    );
    expect(edges).toHaveLength(2);
  });

  it("finds what reaches a function, with the shortest path", () => {
    const reaching = readCallFacts([store, service, route]).reaching({
      functions: [functionOf(store)],
      keys: [],
    });
    expect(callSpellings(reaching.get(functionOf(route)) ?? [])).toEqual([
      "orderService",
      "loadOrder",
    ]);
    expect(reaching.has(functionOf(store))).toBe(false);
  });

  it("finds what a function reaches, in the order it calls", () => {
    const reached = readCallFacts([store, service, route]).reachedFrom([
      functionOf(route),
    ]);
    expect(callSpellings(reached.get(functionOf(store)) ?? [])).toEqual([
      "orderService",
      "loadOrder",
    ]);
  });

  it("counts a function as at the target when it touches it", () => {
    const reaching = readCallFacts([store, service, route]).reaching({
      functions: [],
      keys: [],
      at: [functionOf(service)],
    });
    expect([...reaching.keys()].sort()).toEqual(
      [functionOf(route), functionOf(service)].sort(),
    );
  });

  it("links a caller bound to an export with the function that provides it", () => {
    const provider = boundTo(store, "library");
    const caller = boundTo(unit("checkout"), "caller");
    const facts = readCallFacts([provider, caller]);
    expect(
      facts.callersOf({
        functions: [functionOf(provider)],
        keys: ["fn:@demo/orders::loadOrder"],
      }),
    ).toEqual([
      { caller: functionOf(caller), callee: "fn:@demo/orders::loadOrder" },
    ]);
  });

  it("ends a chain at an export nothing here provides", () => {
    const caller = boundTo(unit("checkout"), "caller");
    const reaching = readCallFacts([caller]).reaching({
      functions: [],
      keys: ["fn:@demo/orders::loadOrder"],
    });
    expect(reaching.get(functionOf(caller))).toEqual([
      { callee: "fn:@demo/orders::loadOrder", to: null, recorded: "bound" },
    ]);
  });

  it("reaches a callback through the function that calls its parameter", () => {
    const callback = unit("onRow");
    const each = unit("eachRow", [
      calls("fn", undefined, { calleeParameter: 0 }),
    ]);
    const caller = unit("report", [
      calls("eachRow", each, {
        argsSummary: { "0": callback.identity.id as string },
      }),
    ]);
    const reached = readCallFacts([callback, each, caller]).reachedFrom([
      functionOf(caller),
    ]);
    expect(reached.get(functionOf(callback))?.at(-1)).toEqual({
      callee: "eachRow, which calls it as fn",
      to: functionOf(callback),
      recorded: "passed",
    });
  });

  it("runs a wrapper the framework puts in front of a unit", () => {
    const guard = unit("requireUser");
    const wrapped = {
      ...unit("showOrder"),
      metadata: withWrapperMetadata(undefined, {
        applied: [{ file: guard.location.file, name: "requireUser" }],
      }),
    };
    const facts = readCallFacts([guard, wrapped]);
    const reached = facts.reachedFrom([functionOf(wrapped)]);
    expect(reached.get(functionOf(guard))).toEqual([
      { callee: "requireUser", to: functionOf(guard), recorded: "wraps" },
    ]);
    expect(
      facts.callersOf({ functions: [functionOf(guard)], keys: [] }),
    ).toEqual([]);
  });

  it("lists a direct caller once, whichever way the call was recorded", () => {
    const provider = boundTo(store, "library");
    const caller = boundTo(
      unit("checkout", [calls("loadOrder", provider)]),
      "caller",
    );
    const callers = readCallFacts([provider, caller]).callersOf({
      functions: [functionOf(provider)],
      keys: ["fn:@demo/orders::loadOrder"],
    });
    expect(callers).toEqual([
      { caller: functionOf(caller), callee: "loadOrder" },
    ]);
  });
});

describe("readCallFacts, reached from each start", () => {
  const store = unit("loadOrder");
  const service = unit("orderService", [calls("loadOrder", store)]);

  function test(
    name: string,
    effects: Effect[],
    mocks: Array<{ module?: string; name?: string; written: string }> = [],
  ): BehavioralSummary {
    return {
      ...unit(name, effects, 1, "src/orders.test.ts"),
      kind: "test",
      metadata: { test: { mocks } },
    };
  }

  it("answers every start in one question, each with its own paths", () => {
    const first = test("loads", [calls("orderService", service)]);
    const second = { ...test("stores", [calls("loadOrder", store)]) };
    second.location = {
      ...second.location,
      range: { start: 20, end: 30 },
    };
    const reached = readCallFacts([
      store,
      service,
      first,
      second,
    ]).reachedFromEach([functionOf(first), functionOf(second)]);

    expect(
      callSpellings(
        reached.get(functionOf(first))?.functions.get(functionOf(store)) ?? [],
      ),
    ).toEqual(["orderService", "loadOrder"]);
    expect(
      callSpellings(
        reached.get(functionOf(second))?.functions.get(functionOf(store)) ?? [],
      ),
    ).toEqual(["loadOrder"]);
  });

  it("refuses a hop into a module the test mocks, and takes it when asked to ignore mocks", () => {
    const mocked = test(
      "loads",
      [calls("orderService", service)],
      [{ module: store.location.file, written: 'vi.mock("./loadOrder.js")' }],
    );
    const facts = readCallFacts([store, service, mocked]);
    const start = functionOf(mocked);

    const past = facts.reachedFromEach([start], { pastMocks: true });
    expect(past.get(start)?.functions.has(functionOf(service))).toBe(true);
    expect(past.get(start)?.functions.has(functionOf(store))).toBe(false);

    const ignoring = facts.reachedFromEach([start]);
    expect(ignoring.get(start)?.functions.has(functionOf(store))).toBe(true);
  });

  it("refuses a spy only on a member with that name, never on a function", () => {
    const method = {
      ...unit("OrderStore.load", [], 40),
      location: {
        file: "src/orderStore.ts",
        range: { start: 40, end: 50 },
        exportName: "OrderStore",
      },
    };
    const spied = test(
      "loads",
      [calls("store.load", method), calls("load", unit("load", [], 60))],
      [{ name: "load", written: 'vi.spyOn(store, "load")' }],
    );
    const plain = unit("load", [], 60);
    const facts = readCallFacts([method, plain, spied]);
    const reached = facts
      .reachedFromEach([functionOf(spied)], { pastMocks: true })
      .get(functionOf(spied));

    expect(reached?.functions.has(functionOf(method))).toBe(false);
    expect(reached?.functions.has(functionOf(plain))).toBe(true);
  });

  it("reaches an export no summary provides through a caller bound to it, unless the package is mocked", () => {
    const caller = boundTo(test("loads", []), "caller");
    const asTest = { ...caller, kind: "test" as const };
    const facts = readCallFacts([asTest]);
    const start = functionOf(asTest);

    expect(
      facts
        .reachedFromEach([start])
        .get(start)
        ?.keys.has("fn:@demo/orders::loadOrder"),
    ).toBe(true);

    const mocked = {
      ...asTest,
      metadata: {
        test: { mocks: [{ module: "@demo/orders", written: "vi.mock" }] },
      },
    };
    const refused = readCallFacts([mocked]).reachedFromEach([start], {
      pastMocks: true,
    });
    expect(refused.get(start)?.keys.size).toBe(0);
  });
});
