/**
 * A pack finds a route by knowing which expression is the app. Every
 * language feature that moves a value is another place the app can be
 * written, so this reads one route per spelling and expects all of
 * them. A row that starts failing is a spelling somebody's service
 * uses and suss stopped seeing.
 */

import path from "node:path";

import { describe, expect, it } from "vitest";

import { fixture, readJson, runSuss, workspace } from "../harness.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

/** Where `const app = express()` is written, and the path that file serves. */
const POSITIONS: ReadonlyArray<readonly [string, string]> = [
  ["/m01", "at the top of a module"],
  ["/m02", "inside a function"],
  ["/m03", "inside an arrow"],
  ["/m04", "inside a block"],
  ["/m05", "inside an immediately invoked function"],
  ["/m06", "inside a class method"],
  ["/m07", "as a class property, reached through this"],
  ["/m08", "destructured out of an object"],
  ["/m09", "left as a property and reached through it"],
  ["/m10", "inside a try"],
];

describe("an app built in any of the places a language allows", () => {
  const out = path.join(workspace("subject-positions"), "api.json");
  const run = runSuss([
    "extract",
    "--dir",
    fixture("subject-positions"),
    "-f",
    "express",
    "-o",
    out,
  ]);

  const served = new Set(
    (readJson(out) as BehavioralSummary[]).flatMap((summary) => {
      const binding = summary.identity.boundaryBinding;
      return binding != null && binding.semantics.name === "rest"
        ? [binding.semantics.path]
        : [];
    }),
  );

  it("reads every file without complaint", () => {
    expect(run.status).toBe(0);
  });

  for (const [servedPath, where] of POSITIONS) {
    it(`finds the route when the app is built ${where}`, () => {
      expect(served).toContain(servedPath);
    });
  }
});
