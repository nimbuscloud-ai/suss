import path from "node:path";

import { describe, expect, it } from "vitest";

import { fixture, readJson, runSuss, workspace } from "../harness.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

/**
 * A service outgrows one file: it builds its apps inside a factory and
 * hands one of them to the files that register on it. The middleware and
 * the prefix that app is mounted under are written two files away from
 * the routes they cover, and a reader given the route file alone has
 * nowhere to go looking.
 */
describe("read a service that registers on an app built in another file", () => {
  const out = workspace("split-routes");
  const summariesFile = path.join(out, "api.json");

  it("says which wrapper runs around a route registered through a parameter", () => {
    const extract = runSuss([
      "extract",
      "--dir",
      fixture("split-routes"),
      "-f",
      "hono",
      "-o",
      summariesFile,
    ]);
    expect(extract.status, extract.stderr).toBe(0);

    const inspect = runSuss(["inspect", summariesFile]);
    expect(inspect.status, inspect.stderr).toBe(0);
    expect(inspect.stdout).toContain(
      "wrapped by requireCaller (fixtures/split-routes/requireCaller.ts) for /api/v1/*",
    );
  });

  it("composes both prefixes a route was mounted under, one of them stated in another file", () => {
    const summaries = readJson(summariesFile) as BehavioralSummary[];
    const routes = summaries.flatMap((one) => {
      const binding = one.identity.boundaryBinding;
      return binding?.semantics.name === "rest" ? [binding.semantics] : [];
    });

    expect(
      routes.map((route) => `${route.method} ${route.path}`).sort(),
    ).toEqual(["GET /api/v1/things/:id", "GET /api/v1/users/:id"]);
  });

  it("reports the middleware's 401 as the route's own behaviour", () => {
    const summaries = readJson(summariesFile) as BehavioralSummary[];
    const route = summaries.find((one) => {
      const semantics = one.identity.boundaryBinding?.semantics;
      return (
        semantics?.name === "rest" && semantics.path === "/api/v1/things/:id"
      );
    });
    expect(route, "no route for /api/v1/things/:id").toBeDefined();

    const outcomes = (route as BehavioralSummary).transitions.map(
      (transition) => [
        transition.output.type === "response" &&
        transition.output.statusCode?.type === "literal"
          ? Number(transition.output.statusCode.value)
          : null,
        (
          transition.metadata?.wrappers as
            | { from?: { name: string } }
            | undefined
        )?.from?.name,
      ],
    );

    expect(outcomes).toEqual([
      [401, "requireCaller"],
      [200, undefined],
    ]);
  });
});
