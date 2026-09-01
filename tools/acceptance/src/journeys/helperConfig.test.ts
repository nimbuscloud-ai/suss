import path from "node:path";

import { describe, expect, it } from "vitest";

import { fixture, readJson, runSuss, workspace } from "../harness.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

/**
 * A project tells suss about its own registration helper through
 * `-f express=express.json`. The helper's module is written relative,
 * the way the README writes it, and that path is relative to the config
 * file rather than to wherever the command was run.
 */
describe("read a registration helper the config file points at", () => {
  const out = workspace("express-helper-config");
  const summariesFile = path.join(out, "api.json");

  function extractWith(config: string) {
    return runSuss([
      "extract",
      "--dir",
      fixture("express-helper-config"),
      "-f",
      `express=${path.join(fixture("express-helper-config"), config)}`,
      "-o",
      summariesFile,
    ]);
  }

  it("reads the route from the relative importModule the README documents", () => {
    const extract = extractWith("express.json");
    expect(extract.status, extract.stderr).toBe(0);

    const summaries = readJson(summariesFile) as BehavioralSummary[];
    const routes = summaries.flatMap((one) => {
      const semantics = one.identity.boundaryBinding?.semantics;
      return semantics?.name === "rest"
        ? [`${semantics.method} ${semantics.path}`]
        : [];
    });
    expect(routes).toEqual(["GET /users"]);
  });

  it("says nothing about a helper it did find", () => {
    expect(extractWith("express.json").stderr).not.toContain("no-helper");
  });

  it("reports a helper name no call in the run matched", () => {
    const extract = extractWith("misspelled.json");
    expect(extract.status, extract.stderr).toBe(0);
    expect(extract.stderr).toContain("no-helper");
    expect(extract.stderr).toContain("registerCruds from crud");
    expect(extract.stderr).toContain("matched no call in this run");
  });
});
