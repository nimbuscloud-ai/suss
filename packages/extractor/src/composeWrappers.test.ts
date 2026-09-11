import { describe, expect, it } from "vitest";

import {
  readWrapperMetadata,
  withHttpMetadata,
  withWrapperMetadata,
} from "@suss/behavioral-ir";

import { composeWrappers } from "./composeWrappers.js";
import { contractStatusGaps } from "./contractStatusGaps.js";

import type {
  BehavioralSummary,
  Gap,
  Predicate,
  Transition,
  WrapperReference,
} from "@suss/behavioral-ir";

function guard(sourceText: string): Predicate {
  return { type: "opaque", sourceText, reason: "complexExpression" };
}

function responds(
  id: string,
  status: number,
  conditions: Predicate[] = [],
): Transition {
  return {
    id,
    conditions,
    output: {
      type: "response",
      statusCode: { type: "literal", value: status },
      body: null,
      headers: {},
    },
    effects: [],
    location: { start: 1, end: 1 },
    isDefault: conditions.length === 0,
  };
}

function throws(id: string, conditions: Predicate[] = []): Transition {
  return {
    id,
    conditions,
    output: { type: "throw", exceptionType: "Error", message: null },
    effects: [],
    location: { start: 1, end: 1 },
    isDefault: false,
  };
}

function continues(id: string, conditions: Predicate[] = []): Transition {
  return {
    id,
    conditions,
    output: { type: "delegate", to: "next" },
    effects: [],
    location: { start: 1, end: 1 },
    isDefault: true,
  };
}

/**
 * A summary the way assembly leaves it: `contract` declares the route's
 * statuses, and the gaps are what the comparison against the handler's
 * own body gave before anything around it was read.
 */
function unit(
  name: string,
  file: string,
  transitions: Transition[],
  options: {
    path?: string;
    wrappers?: WrapperReference[];
    contract?: number[];
    line?: number;
  } = {},
): BehavioralSummary {
  const declaredContract =
    options.contract === undefined
      ? undefined
      : {
          framework: "hono",
          provenance: "derived" as const,
          responses: options.contract.map((statusCode) => ({ statusCode })),
        };
  const withWrappers =
    options.wrappers === undefined
      ? undefined
      : withWrapperMetadata(undefined, { applied: options.wrappers });
  const metadata =
    declaredContract === undefined
      ? withWrappers
      : withHttpMetadata(withWrappers, { declaredContract });
  const gaps =
    declaredContract === undefined
      ? []
      : contractStatusGaps(declaredContract, transitions);
  return {
    kind: "handler",
    location: {
      file,
      range: { start: options.line ?? 1, end: (options.line ?? 1) + 8 },
      exportName: name,
    },
    identity: {
      name,
      exportPath: [name],
      boundaryBinding:
        options.path === undefined
          ? null
          : {
              transport: "http",
              semantics: { name: "rest", method: "GET", path: options.path },
              recognition: "hono",
            },
    },
    inputs: [],
    transitions,
    gaps,
    confidence: { source: "inferred_static", level: "high" },
    ...(metadata === undefined ? {} : { metadata }),
  };
}

const AUTH: WrapperReference = {
  file: "src/requireCaller.ts",
  name: "requireCaller",
};

const statusesOf = (summary: BehavioralSummary): unknown[] =>
  summary.transitions.map((transition) =>
    transition.output.type === "response"
      ? transition.output.statusCode
      : transition.output.type,
  );

const fromOf = (transition: Transition): string | undefined =>
  readWrapperMetadata(transition)?.from?.name;

describe("composeWrappers", () => {
  it("reports what a middleware returns before the handler runs", () => {
    const route = unit("route", "src/app.ts", [responds("ok", 200)], {
      wrappers: [AUTH],
    });
    const middleware = unit("requireCaller", "src/requireCaller.ts", [
      responds("denied", 401, [guard("noToken")]),
      continues("passed", [{ type: "negation", operand: guard("noToken") }]),
    ]);

    const [composed] = composeWrappers([route, middleware]);

    expect(statusesOf(composed)).toEqual([
      { type: "literal", value: 401 },
      { type: "literal", value: 200 },
    ]);
    expect(composed.transitions.map(fromOf)).toEqual([
      "requireCaller",
      undefined,
    ]);
  });

  it("leaves the wrapped unit's own outcomes as they were written", () => {
    const route = unit(
      "route",
      "src/app.ts",
      [
        responds("missing", 404, [guard("notFound")]),
        responds("ok", 200, [{ type: "negation", operand: guard("notFound") }]),
      ],
      { wrappers: [AUTH] },
    );
    const middleware = unit("requireCaller", "src/requireCaller.ts", [
      responds("denied", 401, [guard("noToken")]),
      continues("passed", [{ type: "negation", operand: guard("noToken") }]),
    ]);

    const [composed] = composeWrappers([route, middleware]);

    expect(statusesOf(composed)).toEqual([
      { type: "literal", value: 401 },
      { type: "literal", value: 404 },
      { type: "literal", value: 200 },
    ]);
    expect(composed.transitions[1].conditions).toEqual([guard("notFound")]);
    expect(composed.transitions.map((t) => t.id)).toEqual([
      "denied",
      "missing",
      "ok",
    ]);
  });

  it("adds nothing for a wrapper that only hands the request on", () => {
    const route = unit("route", "src/app.ts", [responds("ok", 200)], {
      wrappers: [AUTH],
    });
    // A filter ending in `header if crawler?` hands on three ways: once
    // outright, and once per arm.
    const middleware = unit("requireCaller", "src/requireCaller.ts", [
      continues("passed"),
      continues("crawler", [guard("crawler")]),
      continues("browser", [{ type: "negation", operand: guard("crawler") }]),
    ]);

    const [composed] = composeWrappers([route, middleware]);

    expect(composed.transitions).toBe(route.transitions);
  });

  it("keeps what a wrapper does on its way through out of the unit", () => {
    const route = unit("route", "src/app.ts", [responds("ok", 200)], {
      wrappers: [AUTH],
    });
    const read: Transition = {
      ...continues("passed"),
      effects: [
        { type: "invocation", callee: "currentUser", args: [], async: false },
      ],
    };
    const middleware = unit("requireCaller", "src/requireCaller.ts", [read]);

    const [composed] = composeWrappers([route, middleware]);

    expect(composed.transitions).toBe(route.transitions);
    expect(composed.transitions[0].effects).toEqual([]);
  });

  it("lists two branching wrappers' responses once each, not one per pairing", () => {
    const first: WrapperReference = { file: "src/first.ts", name: "first" };
    const second: WrapperReference = { file: "src/second.ts", name: "second" };
    const route = unit(
      "route",
      "src/app.ts",
      [
        responds("missing", 404, [guard("notFound")]),
        responds("ok", 200, [{ type: "negation", operand: guard("notFound") }]),
      ],
      { wrappers: [first, second] },
    );
    // Each wrapper hands on two ways and short-circuits one, so the
    // product of the pass-throughs would be four copies of each outcome.
    const branching = (name: string, file: string, status: number) =>
      unit(name, file, [
        responds("denied", status, [guard(`${name}Denied`)]),
        continues(`${name}A`, [guard(`${name}A`)]),
        continues(`${name}B`, [
          { type: "negation", operand: guard(`${name}A`) },
        ]),
      ]);

    const [composed] = composeWrappers([
      route,
      branching("first", "src/first.ts", 401),
      branching("second", "src/second.ts", 403),
    ]);

    expect(statusesOf(composed)).toEqual([
      { type: "literal", value: 401 },
      { type: "literal", value: 403 },
      { type: "literal", value: 404 },
      { type: "literal", value: 200 },
    ]);
    expect(composed.transitions.map(fromOf)).toEqual([
      "first",
      "second",
      undefined,
      undefined,
    ]);
  });

  it("applies a stack of two, the first registered outermost", () => {
    const outer: WrapperReference = { file: "src/outer.ts", name: "outer" };
    const inner: WrapperReference = { file: "src/inner.ts", name: "inner" };
    const route = unit("route", "src/app.ts", [responds("ok", 200)], {
      wrappers: [outer, inner],
    });
    const summaries = [
      route,
      unit("outer", "src/outer.ts", [
        responds("rateLimited", 429, [guard("tooMany")]),
        continues("outerPassed", [
          { type: "negation", operand: guard("tooMany") },
        ]),
      ]),
      unit("inner", "src/inner.ts", [
        responds("denied", 401, [guard("noToken")]),
        continues("innerPassed", [
          { type: "negation", operand: guard("noToken") },
        ]),
      ]),
    ];

    const [composed] = composeWrappers(summaries);

    expect(statusesOf(composed)).toEqual([
      { type: "literal", value: 429 },
      { type: "literal", value: 401 },
      { type: "literal", value: 200 },
    ]);
    expect(composed.transitions.map(fromOf)).toEqual([
      "outer",
      "inner",
      undefined,
    ]);
    // Each wrapper's response keeps the condition its own body tested.
    expect(composed.transitions[0].conditions).toEqual([guard("tooMany")]);
    expect(composed.transitions[1].conditions).toEqual([guard("noToken")]);
    expect(composed.transitions[2].conditions).toEqual([]);
  });

  it("tells two wrappers with the same name in one file apart by line", () => {
    // Two functions written out at their registrations both go by the
    // registering method. Pairing on the name alone applied the first
    // twice and lost what the second returns.
    const first: WrapperReference = {
      file: "src/app.ts",
      name: "use",
      line: 3,
    };
    const second: WrapperReference = {
      file: "src/app.ts",
      name: "use",
      line: 9,
    };
    const route = unit("route", "src/app.ts", [responds("ok", 200)], {
      wrappers: [first, second],
      line: 15,
    });
    const summaries = [
      unit(
        "use",
        "src/app.ts",
        [
          responds("denied", 401, [guard("noToken")]),
          continues("passed", [
            { type: "negation", operand: guard("noToken") },
          ]),
        ],
        { line: 3 },
      ),
      unit(
        "use",
        "src/app.ts",
        [
          responds("banned", 403, [guard("banned")]),
          continues("allowed", [
            { type: "negation", operand: guard("banned") },
          ]),
        ],
        { line: 9 },
      ),
      route,
    ];

    const composed = composeWrappers(summaries)[2];

    expect(statusesOf(composed)).toEqual([
      { type: "literal", value: 401 },
      { type: "literal", value: 403 },
      { type: "literal", value: 200 },
    ]);
  });

  it("lists the error handler's response beside the throw it covers", () => {
    const onError: WrapperReference = {
      file: "src/app.ts",
      name: "onError",
      onThrow: true,
    };
    const route = unit(
      "route",
      "src/app.ts",
      [responds("ok", 200), throws("boom", [guard("invalid")])],
      { wrappers: [onError] },
    );
    const handler = unit("onError", "src/app.ts", [responds("problem", 500)]);

    const [composed] = composeWrappers([route, handler]);

    expect(statusesOf(composed)).toEqual([
      { type: "literal", value: 200 },
      "throw",
      { type: "literal", value: 500 },
    ]);
    expect(composed.transitions[2].conditions).toEqual([]);
    expect(fromOf(composed.transitions[2])).toBe("onError");
  });

  it("leaves a route that never throws alone, error handler or not", () => {
    const onError: WrapperReference = {
      file: "src/app.ts",
      name: "onError",
      onThrow: true,
    };
    const route = unit("route", "src/app.ts", [responds("ok", 200)], {
      wrappers: [onError],
    });
    const handler = unit("onError", "src/app.ts", [responds("problem", 500)]);

    const [composed] = composeWrappers([route, handler]);

    expect(composed).toBe(route);
  });

  it("adds one outcome per error handler response however many throw", () => {
    const onError: WrapperReference = {
      file: "src/app.ts",
      name: "onError",
      onThrow: true,
    };
    const throwing = Array.from({ length: 40 }, (_, i) =>
      throws(`boom${i}`, [guard(`case${i}`)]),
    );
    const route = unit("route", "src/app.ts", throwing, {
      wrappers: [onError],
    });
    const handler = unit("onError", "src/app.ts", [
      responds("problem", 500, [guard("known")]),
      responds("unavailable", 503, [
        { type: "negation", operand: guard("known") },
      ]),
    ]);

    const [composed] = composeWrappers([route, handler]);

    expect(composed.transitions).toHaveLength(42);
    expect(composed.gaps).toEqual([]);
  });

  it("leaves a route the scope does not cover alone", () => {
    const scoped: WrapperReference = { ...AUTH, scope: "/v1/*" };
    const route = unit("health", "src/app.ts", [responds("ok", 200)], {
      path: "/health",
      wrappers: [scoped],
    });
    const middleware = unit("requireCaller", "src/requireCaller.ts", [
      responds("denied", 401, [guard("noToken")]),
      continues("passed"),
    ]);

    const [composed] = composeWrappers([route, middleware]);

    expect(statusesOf(composed)).toEqual([{ type: "literal", value: 200 }]);
    expect(readWrapperMetadata(composed)?.applied).toEqual([]);
  });

  it("composes into a route the scope does cover", () => {
    const scoped: WrapperReference = { ...AUTH, scope: "/v1/*" };
    const route = unit("tenant", "src/app.ts", [responds("ok", 200)], {
      path: "/v1/tenants/{id}",
      wrappers: [scoped],
    });
    const middleware = unit("requireCaller", "src/requireCaller.ts", [
      responds("denied", 401, [guard("noToken")]),
      continues("passed"),
    ]);

    const [composed] = composeWrappers([route, middleware]);

    expect(statusesOf(composed)).toEqual([
      { type: "literal", value: 401 },
      { type: "literal", value: 200 },
    ]);
  });

  it("reports a wrapper's outcomes beside the route's when nothing says where it continues", () => {
    const route = unit("route", "src/app.ts", [responds("ok", 200)], {
      wrappers: [AUTH],
    });
    const middleware = unit("requireCaller", "src/requireCaller.ts", [
      responds("denied", 401, [guard("noToken")]),
    ]);

    const [composed] = composeWrappers([route, middleware]);

    expect(statusesOf(composed)).toEqual([
      { type: "literal", value: 401 },
      { type: "literal", value: 200 },
    ]);
    expect(composed.gaps).toEqual([]);
  });

  it("adds one outcome per wrapper response however wide the unit is", () => {
    const wide = Array.from({ length: 200 }, (_, i) =>
      responds(`ok${i}`, 200, [guard(`case${i}`)]),
    );
    const route = unit("route", "src/app.ts", wide, { wrappers: [AUTH] });
    const middleware = unit("requireCaller", "src/requireCaller.ts", [
      responds("denied", 401, [guard("noToken")]),
      continues("passedA", [guard("a")]),
      continues("passedB", [guard("b")]),
    ]);

    const [composed] = composeWrappers([route, middleware]);

    expect(composed.transitions).toHaveLength(201);
    expect(composed.gaps).toEqual([]);
  });

  it("leaves a unit whose wrapper this run has no summary for alone", () => {
    const route = unit("route", "src/app.ts", [responds("ok", 200)], {
      wrappers: [AUTH],
    });

    const [composed] = composeWrappers([route]);

    expect(composed).toBe(route);
  });

  it("leaves a unit with no wrappers alone", () => {
    const route = unit("route", "src/app.ts", [responds("ok", 200)]);

    expect(composeWrappers([route])[0]).toBe(route);
  });
});

describe("composeWrappers and the declared contract", () => {
  const descriptionsOf = (summary: BehavioralSummary): string[] =>
    summary.gaps.map((gap) => gap.description);

  it("stops reporting a declared status once a middleware is seen to produce it", () => {
    const route = unit("route", "src/app.ts", [responds("ok", 200)], {
      wrappers: [AUTH],
      contract: [200, 401],
    });
    expect(descriptionsOf(route)).toEqual([
      "Declared response 401 is never produced by the handler",
    ]);
    const auth = unit("requireCaller", "src/requireCaller.ts", [
      responds("denied", 401, [guard("!token")]),
      continues("pass", [guard("token")]),
    ]);

    const [composed] = composeWrappers([route, auth]);

    expect(descriptionsOf(composed)).toEqual([]);
  });

  it("says which wrapper produced a status the contract does not declare", () => {
    const route = unit("route", "src/app.ts", [responds("ok", 200)], {
      wrappers: [AUTH],
      contract: [200],
    });
    const auth = unit("requireCaller", "src/requireCaller.ts", [
      responds("limited", 429, [guard("overLimit")]),
      continues("pass", [guard("!overLimit")]),
    ]);

    const [composed] = composeWrappers([route, auth]);

    expect(descriptionsOf(composed)).toEqual([
      "requireCaller, registered around this handler, produces status 429 which is not declared in the hono contract",
    ]);
  });

  it("counts an error handler's response as produced with no visible throw", () => {
    const onError: WrapperReference = {
      file: "src/app.ts",
      name: "onError",
      onThrow: true,
    };
    const route = unit("route", "src/app.ts", [responds("ok", 200)], {
      wrappers: [onError],
      contract: [200, 500],
    });
    expect(descriptionsOf(route)).toEqual([
      "Declared response 500 is never produced by the handler",
    ]);
    const handler = unit("onError", "src/app.ts", [responds("problem", 500)]);

    const [composed] = composeWrappers([route, handler]);

    expect(descriptionsOf(composed)).toEqual([]);
    expect(composed.transitions).toBe(route.transitions);
  });

  it("keeps reporting a declared status when the wrapper only hands on", () => {
    const route = unit("route", "src/app.ts", [responds("ok", 200)], {
      wrappers: [AUTH],
      contract: [200, 404],
    });
    const auth = unit("requireCaller", "src/requireCaller.ts", [
      continues("pass"),
    ]);

    const [composed] = composeWrappers([route, auth]);

    expect(descriptionsOf(composed)).toEqual([
      "Declared response 404 is never produced by the handler",
    ]);
    expect(composed.gaps).toBe(route.gaps);
  });

  it("keeps the gaps that are not about the contract", () => {
    const route = unit("route", "src/app.ts", [responds("ok", 200)], {
      wrappers: [AUTH],
      contract: [200, 401],
    });
    const other: Gap = {
      type: "unfollowedCall",
      conditions: [],
      consequence: "unknown",
      description: "helper() is not followed",
    };
    const withOther = { ...route, gaps: [other, ...route.gaps] };
    const auth = unit("requireCaller", "src/requireCaller.ts", [
      responds("denied", 401, [guard("!token")]),
      continues("pass", [guard("token")]),
    ]);

    const [composed] = composeWrappers([withOther, auth]);

    expect(composed.gaps).toEqual([other]);
  });

  it("adds no gaps when the run asked for none", () => {
    const route = unit("route", "src/app.ts", [responds("ok", 200)], {
      wrappers: [AUTH],
      contract: [200],
    });
    const silent = { ...route, gaps: [] };
    const auth = unit("requireCaller", "src/requireCaller.ts", [
      responds("limited", 429, [guard("overLimit")]),
      continues("pass", [guard("!overLimit")]),
    ]);

    const [composed] = composeWrappers([silent, auth], {
      gapHandling: "silent",
    });

    expect(composed.gaps).toEqual([]);
    expect(statusesOf(composed)).toEqual([
      { type: "literal", value: 429 },
      { type: "literal", value: 200 },
    ]);
  });
});
