import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { fixture, readJson, runSuss, workspace } from "../harness.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

/**
 * One helper, called twice for two different resources, in a file that
 * never mentions express. Following the parameters back from either call
 * leaves two values in every slot, so the routes come from reading the
 * helper once and filling its parameters in at each call instead.
 */
describe("read a helper called twice from a file with no import", () => {
  const out = workspace("express-helper-twice");
  const summariesFile = path.join(out, "api.json");

  it("reports both calls, with no pack config", () => {
    const run = runSuss([
      "extract",
      "--dir",
      fixture("express-helper-twice"),
      "-f",
      "express",
      "-o",
      summariesFile,
    ]);
    expect(run.status, run.stderr).toBe(0);

    const summaries = readJson(summariesFile) as BehavioralSummary[];
    const routes = summaries.flatMap((one) => {
      const semantics = one.identity.boundaryBinding?.semantics;
      return semantics?.name === "rest"
        ? [`${semantics.method} ${semantics.path}`]
        : [];
    });
    expect(routes.sort()).toEqual(["GET /orders", "GET /users"]);
  });

  it("keeps each call's own handler behind its own route", () => {
    const summaries = readJson(summariesFile) as BehavioralSummary[];
    const bodies = summaries.map((one) =>
      JSON.stringify(one.transitions.map((transition) => transition.output)),
    );
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).not.toEqual(bodies[1]);
  });

  it("warns and keeps going when a config file still sets the option", () => {
    const config = path.join(out, "express.json");
    fs.writeFileSync(
      config,
      JSON.stringify({
        registrationHelpers: [
          {
            helperName: "registerCrud",
            registrations: [
              { method: "GET", pathTemplate: "/{1}", handlerArg: "{2}.list" },
            ],
          },
        ],
      }),
    );
    const run = runSuss([
      "extract",
      "--dir",
      fixture("express-helper-twice"),
      "-f",
      `express=${config}`,
      "-o",
      summariesFile,
    ]);
    // 0.20.0 told everyone setting this to write a dependency stub,
    // which was the wrong instruction for a first-party helper, so the
    // key is read past with a warning until 0.22.0 rather than refused.
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).toContain("ignores registrationHelpers");
    expect(run.stderr).toContain("0.22.0");
    expect(run.stderr).not.toContain("suss infer stub");
  });
});
