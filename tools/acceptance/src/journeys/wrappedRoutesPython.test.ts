import path from "node:path";

import { describe, expect, it } from "vitest";

import { fixture, readJson, runSuss, workspace } from "../harness.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

/**
 * The Python counterpart of the wrapped-routes journey. A FastAPI
 * service returns 429 from middleware, 401 and 403 from dependencies
 * and 500 from an exception handler; a flask-restx service returns 401
 * from a before_request hook and 500 from an error handler. None of
 * those appears in the handler, so each wrapper gets a summary of its
 * own, the route points at it, and what the wrapper does is reported as
 * part of what the route does.
 */
describe("read a FastAPI service whose statuses come from around the handler", () => {
  const out = workspace("wrapped-routes-fastapi");
  const summariesFile = path.join(out, "api.json");

  it("says which wrappers run around the route", () => {
    const extract = runSuss([
      "extract",
      "--dir",
      fixture("wrapped-routes-fastapi"),
      "-f",
      "fastapi",
      "-o",
      summariesFile,
    ]);
    expect(extract.status, extract.stderr).toBe(0);

    const inspect = runSuss(["inspect", summariesFile]);
    expect(inspect.status, inspect.stderr).toBe(0);
    expect(inspect.stdout).toContain(
      "wrapped by rate_limit (tenants_api/main.py), require_caller (tenants_api/dependencies.py), require_admin (tenants_api/dependencies.py)",
    );
    expect(inspect.stdout).toContain(
      "on_error (tenants_api/main.py) on a throw",
    );
    expect(inspect.stdout).toContain("429  (from rate_limit)");
  });

  it("points the route at the app's dependency, the middleware, its own dependency and the error handler", () => {
    const summaries = readJson(summariesFile) as BehavioralSummary[];

    expect(
      routeFor(summaries, "POST", "/v1/tenants").metadata?.wrappers,
    ).toEqual({
      applied: [
        { file: "tenants_api/main.py", name: "rate_limit" },
        { file: "tenants_api/dependencies.py", name: "require_caller" },
        { file: "tenants_api/dependencies.py", name: "require_admin" },
        { file: "tenants_api/main.py", name: "on_error", onThrow: true },
      ],
    });
    expect(routeFor(summaries, "GET", "/health").metadata?.wrappers).toEqual({
      applied: [
        { file: "tenants_api/main.py", name: "rate_limit" },
        { file: "tenants_api/dependencies.py", name: "require_caller" },
        { file: "tenants_api/main.py", name: "on_error", onThrow: true },
      ],
    });
  });

  it("puts the statuses on the wrappers that produce them", () => {
    const summaries = readJson(summariesFile) as BehavioralSummary[];
    const statuses = summaries.map((one) => [
      one.identity.name,
      statusesOf(one),
    ]);

    expect(statuses).toContainEqual(["rate_limit", [429]]);
    expect(statuses).toContainEqual(["require_caller", [401]]);
    expect(statuses).toContainEqual(["require_admin", [403]]);
    expect(statuses).toContainEqual(["on_error", [500]]);
  });

  it("reports the wrappers' statuses as the route's own, in the order they run", () => {
    const summaries = readJson(summariesFile) as BehavioralSummary[];

    expect(
      statusesOf(routeFor(summaries, "GET", "/v1/tenants/{tenant_id}")),
    ).toEqual([429, 401, 404, 200]);
    const create = routeFor(summaries, "POST", "/v1/tenants");
    expect(statusesOf(create)).toEqual([429, 401, 403, 201, 500]);
    expect(fromOf(create)).toEqual([
      "rate_limit",
      "require_caller",
      "require_admin",
      undefined,
      "on_error",
    ]);
    expect(
      statusesOf(routeFor(summaries, "DELETE", "/v1/tenants/{tenant_id}")),
    ).toEqual([429, 401, 403, 204]);
  });
});

describe("read a flask-restx service whose statuses come from around the handler", () => {
  const out = workspace("wrapped-routes-flask");
  const summariesFile = path.join(out, "api.json");

  it("says which wrappers run around the resource", () => {
    const extract = runSuss([
      "extract",
      "--dir",
      fixture("wrapped-routes-flask"),
      "-f",
      "flask-restx",
      "-o",
      summariesFile,
    ]);
    expect(extract.status, extract.stderr).toBe(0);

    const inspect = runSuss(["inspect", summariesFile]);
    expect(inspect.status, inspect.stderr).toBe(0);
    expect(inspect.stdout).toContain(
      "wrapped by require_caller (tenants_api/main.py), on_error (tenants_api/main.py) on a throw",
    );
  });

  it("reports the hook's 401 and the handler's 500 as the resource's own", () => {
    const summaries = readJson(summariesFile) as BehavioralSummary[];

    expect(
      statusesOf(routeFor(summaries, "GET", "/v1/tenants/{tenant_id}")),
    ).toEqual([401, 404, 200]);
    const create = routeFor(summaries, "POST", "/v1/tenants");
    expect(statusesOf(create)).toEqual([401, 201, 500]);
    expect(fromOf(create)).toEqual(["require_caller", undefined, "on_error"]);
  });
});

function routeFor(
  summaries: BehavioralSummary[],
  method: string,
  route: string,
): BehavioralSummary {
  const found = summaries.find((one) => {
    const semantics = one.identity.boundaryBinding?.semantics;
    return (
      semantics?.name === "rest" &&
      semantics.method === method &&
      semantics.path === route
    );
  });
  expect(found, `no route for ${method} ${route}`).toBeDefined();
  return found as BehavioralSummary;
}

function statusesOf(summary: BehavioralSummary): number[] {
  return summary.transitions.flatMap((transition) =>
    transition.output.type === "response" &&
    transition.output.statusCode?.type === "literal"
      ? [Number(transition.output.statusCode.value)]
      : [],
  );
}

function fromOf(summary: BehavioralSummary): (string | undefined)[] {
  return summary.transitions.map(
    (transition) =>
      (transition.metadata?.wrappers as { from?: { name: string } } | undefined)
        ?.from?.name,
  );
}
