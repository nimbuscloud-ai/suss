/**
 * The Python half of the subject-positions pair. A pack finds a route by
 * knowing which expression is the app, and every language feature that
 * moves a value is another place the app can be written, so this reads one
 * route per spelling and expects all of them. A row that starts failing is
 * a spelling somebody's service uses and suss stopped seeing.
 */

import path from "node:path";

import { describe, expect, it } from "vitest";

import { fixture, readJson, runSuss, workspace } from "../harness.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

/** Where `app = FastAPI()` is written, and the path that file serves. */
const POSITIONS: ReadonlyArray<readonly [string, string]> = [
  ["/p01", "at the top of a module"],
  ["/p02", "inside an app factory"],
  ["/p03", "inside a function nested in another function"],
  ["/p04", "inside a class method"],
  ["/p05", "on the receiver, wired from another method"],
  ["/p06", "inside a try"],
];

describe("a FastAPI app built in any of the places Python allows", () => {
  const out = path.join(workspace("subject-positions-python"), "api.json");
  const run = runSuss([
    "extract",
    "--dir",
    fixture("subject-positions-python"),
    "--lang",
    "python",
    "-f",
    "fastapi",
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
