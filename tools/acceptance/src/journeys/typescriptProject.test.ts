// A person points suss at a TypeScript service and reads back its
// routes.
//
// The fixture declares four routes and a handful of status codes in
// plain Express. Everything asserted here is something a person would
// look for in the output: the route is there, it is spelled the way
// they would search for it, and the branches they wrote are the
// branches suss reports.

import path from "node:path";

import { describe, expect, it } from "vitest";

import { fixture, readJson, runSuss, workspace } from "../harness.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

/** Every route in this fixture, spelled the way Express spells it. */
const DECLARED_ROUTES = [
  "GET /users/:id",
  "GET /old-profile",
  "GET /moved",
  "* /webhooks/:source",
];

/**
 * The same routes as a person reads them back. `inspect` prints the
 * canonical form, so a route pairs against a client that wrote its
 * parameter some other way.
 */
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

    // The guard, the miss, the admin case, and the ordinary one, each
    // with the status the fixture writes at that point.
    expect(inspect.stdout).toContain("-> 400 { error }");
    expect(inspect.stdout).toContain("-> 404 { error }");
    expect(inspect.stdout).toContain("-> 200 { id, name, role, admin }");
    // A redirect with no status argument is a 302; the two-argument
    // form carries its own.
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

    // handlers.ts registers the first route on line 17 and the last on
    // line 55. A summary carrying a byte offset here would print a
    // number past the end of a 66-line file.
    expect(inspect.stdout).toContain(
      "GET /users/{id}  (express handler | line 17)",
    );
    expect(inspect.stdout).toContain(
      "* /webhooks/{source}  (express handler | line 55)",
    );
  });
});
