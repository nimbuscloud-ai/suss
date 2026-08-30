import { describe, expect, it } from "vitest";

import { readWrapperMetadata, withWrapperMetadata } from "@suss/behavioral-ir";

import { composeWrappers } from "./composeWrappers.js";
import { MAX_PATHS } from "./paths/enumeratePaths.js";

import type {
  BehavioralSummary,
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

function unit(
  name: string,
  file: string,
  transitions: Transition[],
  options: { path?: string; wrappers?: WrapperReference[] } = {},
): BehavioralSummary {
  const metadata =
    options.wrappers === undefined
      ? undefined
      : withWrapperMetadata(undefined, { applied: options.wrappers });
  return {
    kind: "handler",
    location: { file, range: { start: 1, end: 9 }, exportName: name },
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
    gaps: [],
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

  it("carries the pass-through conditions onto every outcome behind it", () => {
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
    expect(composed.transitions[1].conditions).toEqual([
      { type: "negation", operand: guard("noToken") },
      guard("notFound"),
    ]);
    expect(new Set(composed.transitions.map((t) => t.id)).size).toBe(3);
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
    // The outer middleware let it through, then the inner one did.
    expect(composed.transitions[1].conditions).toEqual([
      { type: "negation", operand: guard("tooMany") },
      guard("noToken"),
    ]);
    expect(composed.transitions[2].conditions).toEqual([
      { type: "negation", operand: guard("tooMany") },
      { type: "negation", operand: guard("noToken") },
    ]);
  });

  it("puts the error handler's response where the handler threw", () => {
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
      { type: "literal", value: 500 },
    ]);
    expect(composed.transitions[1].conditions).toEqual([guard("invalid")]);
    expect(fromOf(composed.transitions[1])).toBe("onError");
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

  it("degrades an error handler over more throws than the budget allows", () => {
    const onError: WrapperReference = {
      file: "src/app.ts",
      name: "onError",
      onThrow: true,
    };
    const throwing = Array.from({ length: MAX_PATHS }, (_, i) =>
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

    expect(composed.transitions).toHaveLength(MAX_PATHS + 2);
    expect(composed.gaps.map((gap) => gap.type)).toEqual(["unreadOutcome"]);
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

  it("degrades to the two sides side by side rather than going past the path budget", () => {
    const wide = Array.from({ length: MAX_PATHS }, (_, i) =>
      responds(`ok${i}`, 200, [guard(`case${i}`)]),
    );
    const route = unit("route", "src/app.ts", wide, { wrappers: [AUTH] });
    const middleware = unit("requireCaller", "src/requireCaller.ts", [
      responds("denied", 401, [guard("noToken")]),
      continues("passedA", [guard("a")]),
      continues("passedB", [guard("b")]),
    ]);

    const [composed] = composeWrappers([route, middleware]);

    expect(composed.transitions).toHaveLength(MAX_PATHS + 1);
    expect(composed.gaps.map((gap) => gap.type)).toEqual(["unreadOutcome"]);
    expect(composed.gaps[0].description).toContain(String(MAX_PATHS));
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
