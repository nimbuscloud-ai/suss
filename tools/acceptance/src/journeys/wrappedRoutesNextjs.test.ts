import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { fixture, readSummaries, runSuss, workspace } from "../harness.js";

import type { BehavioralSummary, Finding } from "@suss/behavioral-ir";

/**
 * A Next.js app whose route exports are written as calls. A logging
 * library builds two of the wrappers, so the run cannot read them, and
 * the project's own wrappers either hand back a closure of their own or
 * hand one to the library's wrapper. Every route still gets a summary
 * of the function it was written with, the wrappers the run read add
 * their statuses, and a wrapper it could not read keeps the checker
 * from claiming a status is never sent.
 */
describe("read a Next.js app whose routes are wrapped in calls", () => {
  const out = workspace("wrapped-routes-nextjs");
  const summariesFile = path.join(out, "code.json");

  beforeAll(() => {
    const extract = runSuss([
      "extract",
      "--dir",
      fixture("wrapped-routes-nextjs"),
      "-f",
      "nextjs",
      "-f",
      "fetch",
      "-o",
      summariesFile,
    ]);
    expect(extract.status, extract.stderr).toBe(0);
  });

  it("gives every route export a summary", () => {
    const summaries = readSummaries(summariesFile);
    expect(routesOf(summaries)).toEqual([
      "GET /api/admin/stats",
      "GET /api/health",
      "GET /api/links",
      "HEAD /api/health",
      "POST /api/jobs/process/{jobName}",
      "POST /api/links",
    ]);
  });

  it("records a library's wrapper as a layer around the route", () => {
    const summaries = readSummaries(summariesFile);
    const job = routeFor(summaries, "POST", "/api/jobs/process/{jobName}");

    expect(job.metadata?.wrappers).toEqual({
      applied: [
        {
          file: "fixtures/wrapped-routes-nextjs/lib/axiom/server.ts",
          name: "withAxiomBodyLog",
        },
      ],
    });
    expect(statusesOf(job)).toEqual([404, 200]);
  });

  it("adds the statuses of the project's own wrapper inside the library's", () => {
    const summaries = readSummaries(summariesFile);
    const create = routeFor(summaries, "POST", "/api/links");

    expect(wrapperNamesOf(create)).toEqual([
      "withAxiomBodyLog",
      "withWorkspace(handler)",
    ]);
    expect(statusesOf(create)).toEqual([401, 422, 201]);
  });

  it("adds the statuses of a closure the project's wrapper hands back", () => {
    const summaries = readSummaries(summariesFile);
    const stats = routeFor(summaries, "GET", "/api/admin/stats");

    expect(wrapperNamesOf(stats)).toEqual(["withAdmin(handler)"]);
    expect(statusesOf(stats)).toEqual([403, 200]);
  });

  it("says which wrappers run around a route", () => {
    const inspect = runSuss(["inspect", summariesFile]);
    expect(inspect.status, inspect.stderr).toBe(0);
    expect(inspect.stdout).toContain(
      "POST /api/links  (nextjs handler | line 13 | wrapped by withAxiomBodyLog (fixtures/wrapped-routes-nextjs/lib/axiom/server.ts), withWorkspace(handler) (fixtures/wrapped-routes-nextjs/lib/auth/workspace.ts))",
    );
    expect(inspect.stdout).toContain(
      "401 { error }  (from withWorkspace(handler))",
    );
  });

  it("does not call a branch dead when a wrapper the run could not read may send its status", () => {
    const check = runSuss(["check", "--dir", out, "--json"]);
    const findings = (JSON.parse(check.stdout) as { findings: Finding[] })
      .findings;

    expect(
      findings.map((finding) => `${finding.kind} ${finding.description}`),
    ).toEqual([
      "lowConfidence Consumer expects status 401, and part of the provider went unread, such as a wrapper around it, so this cannot be confirmed either way",
      "unhandledProviderCase Provider produces status 403 but no consumer branch handles it",
      "deadConsumerBranch Consumer expects status 410 but provider never produces it",
    ]);
  });
});

function routesOf(summaries: readonly BehavioralSummary[]): string[] {
  return summaries
    .flatMap((summary) => {
      const semantics = summary.identity.boundaryBinding?.semantics;
      return semantics?.name === "rest" && summary.kind === "handler"
        ? [`${semantics.method} ${semantics.path}`]
        : [];
    })
    .sort();
}

function routeFor(
  summaries: readonly BehavioralSummary[],
  method: string,
  path: string,
): BehavioralSummary {
  const route = summaries.find((one) => {
    const semantics = one.identity.boundaryBinding?.semantics;
    return (
      semantics?.name === "rest" &&
      semantics.method === method &&
      semantics.path === path
    );
  });
  expect(route, `no route for ${method} ${path}`).toBeDefined();
  return route as BehavioralSummary;
}

function wrapperNamesOf(summary: BehavioralSummary): string[] {
  const wrappers = summary.metadata?.wrappers as
    | { applied: { name: string }[] }
    | undefined;
  return (wrappers?.applied ?? []).map((one) => one.name);
}

function statusesOf(summary: BehavioralSummary): number[] {
  return summary.transitions.flatMap((transition) =>
    transition.output.type === "response" &&
    transition.output.statusCode?.type === "literal" &&
    typeof transition.output.statusCode.value === "number"
      ? [transition.output.statusCode.value]
      : [],
  );
}
