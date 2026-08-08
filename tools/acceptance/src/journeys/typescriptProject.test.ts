import path from "node:path";

import { describe, expect, it } from "vitest";

import { fixture, readJson, runSuss, workspace } from "../harness.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const DECLARED_ROUTES = [
  "GET /users/:id",
  "GET /old-profile",
  "GET /moved",
  "* /webhooks/:source",
];

const ROUTES_AS_READ_BACK = [
  "GET /users/{id}",
  "GET /old-profile",
  "GET /moved",
  "* /webhooks/{source}",
];

describe("read a TypeScript service", () => {
  const out = workspace("typescript");
  const summariesFile = path.join(out, "api.json");

  it("finds every route the fixture declares", () => {
    const extract = runSuss([
      "extract",
      "--dir",
      fixture("express"),
      "-f",
      "express",
      "-o",
      summariesFile,
    ]);
    expect(extract.status, extract.stderr).toBe(0);

    const inspect = runSuss(["inspect", summariesFile]);
    expect(inspect.status, inspect.stderr).toBe(0);
    for (const route of ROUTES_AS_READ_BACK) {
      expect(inspect.stdout).toContain(route);
    }
    expect(inspect.stdout).toContain("4 summaries.");
  });

  it("reports the branches and statuses the handler was written with", () => {
    const inspect = runSuss(["inspect", summariesFile]);

    expect(inspect.stdout).toContain("-> 400 { error }");
    expect(inspect.stdout).toContain("-> 404 { error }");
    expect(inspect.stdout).toContain("-> 200 { id, name, role, admin }");
    // A redirect with no status argument is a 302.
    expect(inspect.stdout).toContain("-> 302");
    expect(inspect.stdout).toContain("-> 301");
  });

  it("writes summaries another command can read", () => {
    const summaries = readJson(summariesFile) as BehavioralSummary[];
    expect(Array.isArray(summaries)).toBe(true);

    const paths = summaries
      .map((s) => s.identity.boundaryBinding?.semantics)
      .filter((s) => s?.name === "rest")
      .map((s) => `${s?.method} ${s?.path}`)
      .sort();
    expect(paths).toEqual([...DECLARED_ROUTES].sort());
  });

  it("says which line each route is on, so a person can go there", () => {
    const inspect = runSuss(["inspect", summariesFile]);

    expect(inspect.stdout).toContain(
      "GET /users/{id}  (express handler | line 17)",
    );
    expect(inspect.stdout).toContain(
      "* /webhooks/{source}  (express handler | line 55)",
    );
  });
});
