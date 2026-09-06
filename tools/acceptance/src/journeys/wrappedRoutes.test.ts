import path from "node:path";

import { describe, expect, it } from "vitest";

import { fixture, readJson, runSuss, workspace } from "../harness.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

/**
 * A route's wire behaviour is not only its own body. This service
 * returns 401 from middleware, 400 from a validation hook and 500 from
 * an error handler, and none of those appears in the handler, so a
 * reader given the handler alone has nowhere to go looking. Each
 * wrapper gets a summary of its own, the route points at it, and what
 * the wrapper does is reported as part of what the route does.
 */
describe("read a service whose statuses come from around the handler", () => {
  const out = workspace("wrapped-routes");
  const summariesFile = path.join(out, "api.json");

  it("says which wrappers run around the route", () => {
    const extract = runSuss([
      "extract",
      "--dir",
      fixture("wrapped-routes"),
      "-f",
      "hono",
      "-o",
      summariesFile,
    ]);
    expect(extract.status, extract.stderr).toBe(0);

    const inspect = runSuss(["inspect", summariesFile]);
    expect(inspect.status, inspect.stderr).toBe(0);
    expect(inspect.stdout).toContain(
      "wrapped by requireCaller (fixtures/wrapped-routes/requireCaller.ts) for /v1/*",
    );
    expect(inspect.stdout).toContain(
      "onError (fixtures/wrapped-routes/app.ts) on a throw",
    );
    expect(inspect.stdout).toContain(
      "validationHook (fixtures/wrapped-routes/validationHook.ts)",
    );
  });

  it("points the route at each wrapper's own summary", () => {
    const summaries = readJson(summariesFile) as BehavioralSummary[];
    const route = routeFor(summaries, "/v1/tenants/:id");

    expect(route.metadata?.wrappers).toEqual({
      applied: [
        {
          file: "fixtures/wrapped-routes/requireCaller.ts",
          name: "requireCaller",
          scope: "/v1/*",
        },
        {
          file: "fixtures/wrapped-routes/app.ts",
          name: "onError",
          onThrow: true,
        },
        {
          file: "fixtures/wrapped-routes/validationHook.ts",
          name: "validationHook",
        },
      ],
    });
  });

  it("puts the statuses on the wrappers that produce them", () => {
    const summaries = readJson(summariesFile) as BehavioralSummary[];
    const statuses = summaries.map((one) => [
      one.identity.name,
      one.transitions.flatMap((transition) =>
        transition.output.type === "response" &&
        transition.output.statusCode?.type === "literal"
          ? [transition.output.statusCode.value]
          : [],
      ),
    ]);

    expect(statuses).toContainEqual(["requireCaller", [401]]);
    expect(statuses).toContainEqual(["onError", [500]]);
    expect(statuses).toContainEqual(["validationHook", [400]]);
  });

  it("reports the middleware's 401, the hook's 400 and the error handler's 500 as the route's own behaviour", () => {
    const summaries = readJson(summariesFile) as BehavioralSummary[];

    expect(statusesOf(routeFor(summaries, "/v1/tenants/:id"))).toEqual([
      401, 400, 404, 200,
    ]);
    expect(statusesOf(routeFor(summaries, "/v1/tenants"))).toEqual([
      401, 400, 201, 500,
    ]);
  });

  it("says which wrapper each of those came from", () => {
    const summaries = readJson(summariesFile) as BehavioralSummary[];
    const route = routeFor(summaries, "/v1/tenants");

    expect(
      route.transitions.map(
        (transition) =>
          (
            transition.metadata?.wrappers as
              | { from?: { name: string } }
              | undefined
          )?.from?.name,
      ),
    ).toEqual(["requireCaller", "validationHook", undefined, "onError"]);
  });

  it("reports the hook's 400 on a route outside the middleware's path pattern", () => {
    const summaries = readJson(summariesFile) as BehavioralSummary[];
    const health = routeFor(summaries, "/health");

    expect(statusesOf(health)).toEqual([400, 200]);
    expect(health.metadata?.wrappers).toEqual({
      applied: [
        {
          file: "fixtures/wrapped-routes/app.ts",
          name: "onError",
          onThrow: true,
        },
        {
          file: "fixtures/wrapped-routes/validationHook.ts",
          name: "validationHook",
        },
      ],
    });
  });

  it("says on every route that a factory it could not read registered something", () => {
    const summaries = readJson(summariesFile) as BehavioralSummary[];

    for (const path of ["/v1/tenants/:id", "/v1/tenants", "/health"]) {
      const route = routeFor(summaries, path);
      expect(unfollowedCalleesOf(route)).toContain("pickMiddleware");
      expect(wrapperNamesOf(route)).not.toContain("pickMiddleware");
    }
  });
});

function wrapperNamesOf(summary: BehavioralSummary): string[] {
  const wrappers = summary.metadata?.wrappers as
    | { applied: { name: string }[] }
    | undefined;
  return (wrappers?.applied ?? []).map((one) => one.name);
}

function unfollowedCalleesOf(summary: BehavioralSummary): string[] {
  return summary.gaps.flatMap((gap) =>
    gap.type === "unfollowedCall" && gap.callee !== undefined
      ? [gap.callee]
      : [],
  );
}

function routeFor(
  summaries: BehavioralSummary[],
  path: string,
): BehavioralSummary {
  const route = summaries.find((one) => {
    const semantics = one.identity.boundaryBinding?.semantics;
    return semantics?.name === "rest" && semantics.path === path;
  });
  expect(route, `no route for ${path}`).toBeDefined();
  return route as BehavioralSummary;
}

function statusesOf(summary: BehavioralSummary): number[] {
  return summary.transitions.flatMap((transition) =>
    transition.output.type === "response" &&
    transition.output.statusCode?.type === "literal"
      ? [Number(transition.output.statusCode.value)]
      : [],
  );
}
