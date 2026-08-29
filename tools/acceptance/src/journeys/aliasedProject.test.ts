/**
 * A service that keeps its route objects on a shared contract module and
 * imports them through the project's own "@/" alias. Reading it needs
 * the project's tsconfig, so this journey covers being pointed at the
 * project, and being pointed at a directory holding several of them.
 */

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  copyOfFixture,
  fixture,
  readJson,
  runSuss,
  workspace,
} from "../harness.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const ROUTES = [
  "GET /v1/tenants/{tenantId}",
  "POST /v1/tenants/{tenantId}/provision",
];

function routesIn(file: string): string[] {
  const summaries = readJson(file) as BehavioralSummary[];
  return summaries
    .map((summary) => summary.identity.boundaryBinding)
    .flatMap((binding) =>
      binding !== undefined &&
      binding !== null &&
      binding.semantics.name === "rest"
        ? [`${binding.semantics.method} ${binding.semantics.path}`]
        : [],
    )
    .sort();
}

describe("read a project whose imports go through its own alias", () => {
  const out = workspace("aliases");
  const summariesFile = path.join(out, "api.json");

  it("finds the routes when pointed at the project", () => {
    const run = runSuss([
      "extract",
      "-p",
      path.join(fixture("path-aliases"), "tsconfig.json"),
      "-f",
      "hono",
      "-o",
      summariesFile,
    ]);

    expect(run.status).toBe(0);
    expect(routesIn(summariesFile)).toEqual(ROUTES);
  });

  it("finds them from inside the project with no tsconfig named", () => {
    const file = path.join(out, "nearest.json");
    const run = runSuss(["extract", "-f", "hono", "-o", file], {
      cwd: fixture("path-aliases"),
    });

    expect(run.status).toBe(0);
    expect(routesIn(file)).toEqual(ROUTES);
  });
});

describe("point suss at a directory holding several projects", () => {
  const project = copyOfFixture("path-aliases", "sibling-projects");
  const parent = path.dirname(project);

  const secondProject = path.join(parent, "job");
  fs.mkdirSync(path.join(secondProject, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(secondProject, "src", "index.ts"),
    "export const run = () => null;\n",
  );
  fs.writeFileSync(
    path.join(secondProject, "tsconfig.json"),
    '{ "include": ["src"] }\n',
  );

  const file = path.join(workspace("sibling-out"), "api.json");
  const run = runSuss(["extract", "--dir", parent, "-f", "hono", "-o", file]);

  it("names the projects it did not read as projects", () => {
    expect(run.stderr).toContain("job/tsconfig.json");
    expect(run.stderr).toContain("project/tsconfig.json");
  });

  it("says an import through an alias reached nothing", () => {
    expect(run.stderr).toContain("resolves to nothing");
  });

  it("gives the command that reads one project", () => {
    expect(run.stderr).toContain("suss extract -p job/tsconfig.json");
  });

  it("loses the routes, which is what the notice is about", () => {
    expect(run.status).toBe(0);
    expect(routesIn(file)).toEqual([]);
  });
});
