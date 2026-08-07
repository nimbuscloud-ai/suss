// The ALB selector: which match a listener hands a request to, over
// match records as albFlow.ts emits them. ALB's own corners are the
// point: `*` crosses `/`, hosts fold case and paths do not, lowest
// priority wins with the default last, and anything the selector
// cannot settle leaves matches possible rather than admitted or
// refused.

import { describe, expect, it } from "vitest";

import { albRouterSelector } from "./albMatch.js";

import type {
  FlowRequest,
  RoutingMatchCondition,
  RoutingMatchRecord,
} from "@suss/behavioral-ir";

function request(over: Partial<FlowRequest> = {}): FlowRequest {
  return { method: "GET", host: "shop.example.com", path: "/a", ...over };
}

function pathMatch(...values: string[]): RoutingMatchCondition {
  return { field: "path-pattern", values, evaluated: true };
}

function record(
  matchId: string,
  conditions: RoutingMatchCondition[],
  priority?: number,
): RoutingMatchRecord {
  return {
    matchId,
    conditions,
    ...(priority !== undefined ? { priority } : {}),
  };
}

describe("condition matching", () => {
  it("reads * across segments and ? as one character, case-sensitively on paths", () => {
    const rules = [record("wild", [pathMatch("/api/orders/*")], 1)];
    expect(
      albRouterSelector(rules, request({ path: "/api/orders/a/b" })),
    ).toEqual({ admitted: ["wild"], possible: [] });
    expect(
      albRouterSelector(
        [record("one", [pathMatch("/file?")], 1)],
        request({ path: "/filex" }),
      ),
    ).toEqual({ admitted: ["one"], possible: [] });
    expect(
      albRouterSelector(rules, request({ path: "/API/orders/1" })),
    ).toEqual({ admitted: [], possible: [] });
  });

  it("folds case on host-header values, and ORs values within one field", () => {
    const rules = [
      record(
        "hosts",
        [
          {
            field: "host-header",
            values: ["Shop.Example.com", "*.example.org"],
            evaluated: true,
          },
        ],
        1,
      ),
    ];
    expect(albRouterSelector(rules, request())).toEqual({
      admitted: ["hosts"],
      possible: [],
    });
    expect(
      albRouterSelector(rules, request({ host: "api.example.org" })),
    ).toEqual({ admitted: ["hosts"], possible: [] });
    expect(albRouterSelector(rules, request({ host: "other.io" }))).toEqual({
      admitted: [],
      possible: [],
    });
  });

  it("leaves a host-header rule possible when the request names no host", () => {
    const rules = [
      record(
        "hosts",
        [
          {
            field: "host-header",
            values: ["shop.example.com"],
            evaluated: true,
          },
        ],
        1,
      ),
    ];
    expect(albRouterSelector(rules, request({ host: null }))).toEqual({
      admitted: [],
      possible: ["hosts"],
    });
  });

  it("ANDs fields: a refusing path settles the match however many fields abstain", () => {
    const rules = [
      record(
        "gated",
        [
          { field: "http-request-method", values: ["POST"], evaluated: false },
          pathMatch("/other"),
        ],
        1,
      ),
    ];
    expect(albRouterSelector(rules, request())).toEqual({
      admitted: [],
      possible: [],
    });
  });

  it("never admits on an empty values list the reader recorded as such", () => {
    const rules = [record("empty", [pathMatch()], 1)];
    expect(albRouterSelector(rules, request())).toEqual({
      admitted: [],
      possible: [],
    });
  });

  it("admits a match with no conditions at all: the listener's own default", () => {
    expect(albRouterSelector([record("default", [])], request())).toEqual({
      admitted: ["default"],
      possible: [],
    });
  });
});

describe("priority selection", () => {
  it("hands the request to the lowest matching priority, the default last", () => {
    const rules = [
      record("default", []),
      record("late", [pathMatch("/a")], 20),
      record("early", [pathMatch("/a")], 10),
    ];
    expect(albRouterSelector(rules, request())).toEqual({
      admitted: ["early"],
      possible: [],
    });
  });

  it("lands an unmatched path on the default action", () => {
    const rules = [record("default", []), record("only", [pathMatch("/b")], 5)];
    expect(albRouterSelector(rules, request())).toEqual({
      admitted: ["default"],
      possible: [],
    });
  });

  it("leaves everything possible when an unevaluated match stands above a settled one", () => {
    const rules = [
      record(
        "gate",
        [
          pathMatch("/a"),
          { field: "http-header", values: ["X-Canary=1"], evaluated: false },
        ],
        1,
      ),
      record("settled", [pathMatch("/a")], 2),
      record("below", [pathMatch("/a")], 3),
    ];
    // The gate might take the request; if it does not, "settled" does.
    // Either way "below" never sees it, so it is the one certain no.
    expect(albRouterSelector(rules, request())).toEqual({
      admitted: [],
      possible: ["gate", "settled"],
    });
  });

  it("treats a settled tie as undeclared ordering: both possible, nothing below them", () => {
    const rules = [
      record("a", [pathMatch("/a", "/both")], 15),
      record("b", [pathMatch("/a")], 15),
      record("below", [pathMatch("/a")], 16),
    ];
    expect(albRouterSelector(rules, request())).toEqual({
      admitted: [],
      possible: ["a", "b"],
    });
  });

  it("keeps a tie harmless when only one of its matches admits the request", () => {
    const rules = [
      record("a", [pathMatch("/a")], 15),
      record("b", [pathMatch("/b")], 15),
    ];
    expect(albRouterSelector(rules, request())).toEqual({
      admitted: ["a"],
      possible: [],
    });
  });
});
