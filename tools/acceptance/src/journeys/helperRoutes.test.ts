import path from "node:path";

import { describe, expect, it } from "vitest";

import { fixture, readJson, runSuss, workspace } from "../harness.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

/**
 * A service hands its app to functions of its own and those functions
 * write the routes. Only the file that calls `express()` says which
 * library this is, so a reader given a helper on its own cannot tell a
 * route registration from any other call on any other object.
 */
describe("read the routes a project's own helpers register", () => {
  const out = workspace("express-helpers");
  const summariesFile = path.join(out, "api.json");

  function routes(): string[] {
    const summaries = readJson(summariesFile) as BehavioralSummary[];
    return summaries
      .flatMap((one) => {
        const semantics = one.identity.boundaryBinding?.semantics;
        return semantics?.name === "rest" ? [semantics] : [];
      })
      .map((route) => `${route.method} ${route.path}`)
      .sort();
  }

  it("reads a route a helper writes beside one written at the app", () => {
    const extract = runSuss([
      "extract",
      "--dir",
      fixture("express-helpers"),
      "-f",
      "express",
      "-o",
      summariesFile,
    ]);
    expect(extract.status, extract.stderr).toBe(0);

    expect(routes()).toContain("GET /health");
    expect(routes()).toContain("GET /direct");
  });

  it("resolves a path and a handler the call site supplied", () => {
    expect(routes()).toContain("GET /users");
    expect(routes()).toContain("POST /users");
  });

  it("reads no route off an object that is not the app", () => {
    expect(routes()).toEqual([
      "GET /direct",
      "GET /health",
      "GET /users",
      "POST /users",
    ]);
  });

  it("reports the status the call site's own handler sends", () => {
    const summaries = readJson(summariesFile) as BehavioralSummary[];
    const created = summaries.find((one) => {
      const semantics = one.identity.boundaryBinding?.semantics;
      return semantics?.name === "rest" && semantics.path === "/users";
    });
    expect(created, "no route for /users").toBeDefined();
    expect(
      (created as BehavioralSummary).transitions.map((transition) =>
        transition.output.type === "response" &&
        transition.output.statusCode?.type === "literal"
          ? Number(transition.output.statusCode.value)
          : null,
      ),
    ).toEqual([200]);
  });

  it("says nothing extra when the one caller settles the app", () => {
    const summaries = readJson(summariesFile) as BehavioralSummary[];
    expect(summaries.flatMap((one) => one.gaps)).toEqual([]);
  });
});

/**
 * Two apps flow into one helper, so the app its route belongs to is not
 * decided. Picking one would put a route on the wrong app, so the run
 * declines, and says which call it stopped at.
 */
describe("say which registration a second app took away", () => {
  const out = workspace("express-two-apps");
  const summariesFile = path.join(out, "api.json");

  it("says which call it stopped at and how many apps it found", () => {
    const extract = runSuss([
      "extract",
      "--dir",
      fixture("express-two-apps"),
      "-f",
      "express",
      "-o",
      summariesFile,
    ]);
    expect(extract.status, extract.stderr).toBe(0);

    const summaries = readJson(summariesFile) as BehavioralSummary[];
    const stops = summaries
      .flatMap((one) => one.gaps)
      .filter((gap) => gap.type === "unfollowedCall");
    expect(stops).toHaveLength(1);
    expect(stops[0].callee).toBe("target.get");
    expect(stops[0].description).toContain("2 different values");
  });

  it("claims no route it could not attribute", () => {
    const summaries = readJson(summariesFile) as BehavioralSummary[];
    const routes = summaries.flatMap((one) => {
      const semantics = one.identity.boundaryBinding?.semantics;
      return semantics?.name === "rest" ? [semantics.path] : [];
    });
    expect(routes).toEqual(["/direct"]);
  });

  it("reads the handler behind the registration it declined", () => {
    const inspect = runSuss(["inspect", summariesFile]);
    expect(inspect.status, inspect.stderr).toBe(0);
    expect(inspect.stdout).toContain("Could not follow:");
    expect(inspect.stdout).toContain("200 { ok }");
  });
});
