import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";
import { createFixtureProject } from "@suss/test-project";

import { nextjsFramework } from "./index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const fixturesDir = path.resolve(__dirname, "../../../../fixtures/nextjs");

async function runAdapter(): Promise<BehavioralSummary[]> {
  const project = createFixtureProject(fixturesDir, "**/*.ts");

  const adapter = createTypeScriptAdapter({
    project,
    frameworks: [nextjsFramework()],
  });

  return await adapter.extractAll();
}

function routeOf(summary: BehavioralSummary): string {
  const binding = summary.identity.boundaryBinding;
  if (binding === null || binding.semantics.name !== "rest") {
    return "<not a route>";
  }
  return `${binding.semantics.method} ${binding.semantics.path}`;
}

function statusesOf(summary: BehavioralSummary): number[] {
  const codes: number[] = [];
  for (const t of summary.transitions) {
    if (
      t.output.type === "response" &&
      t.output.statusCode?.type === "literal"
    ) {
      codes.push(t.output.statusCode.value as number);
    }
  }
  return codes.sort((a, b) => a - b);
}

describe("nextjsFramework: pack shape", () => {
  it("finds route files by where they sit, not by an import", () => {
    const pack = nextjsFramework();
    expect(pack.name).toBe("nextjs");
    expect(pack.discovery.map((d) => d.match.type)).toEqual([
      "fileConvention",
      "fileConvention",
    ]);
  });
});

describe("nextjsFramework: extraction", () => {
  let summaries: BehavioralSummary[];

  beforeAll(async () => {
    summaries = await runAdapter();
  }, 90_000);

  it("reads one handler per method a route file exports", () => {
    expect(summaries.map(routeOf).sort()).toEqual([
      "* /api/legacy",
      "DELETE /api/orders/{id}",
      "GET /api/orders",
      "GET /api/orders/{id}",
      "POST /api/orders",
    ]);
  });

  it("reads a response the handler constructs", () => {
    const post = summaries.find(
      (s) => routeOf(s) === "POST /api/orders",
    ) as BehavioralSummary;
    expect(statusesOf(post)).toEqual([201, 400]);
  });

  it("reads the statuses a handler answers with", () => {
    const get = summaries.find(
      (s) => routeOf(s) === "GET /api/orders/{id}",
    ) as BehavioralSummary;
    expect(statusesOf(get)).toEqual([200, 404]);
  });

  it("takes the status off the init object", () => {
    const del = summaries.find(
      (s) => routeOf(s) === "DELETE /api/orders/{id}",
    ) as BehavioralSummary;
    expect(statusesOf(del)).toEqual([202, 404]);
  });

  it("reads the body a handler sends", () => {
    const list = summaries.find(
      (s) => routeOf(s) === "GET /api/orders",
    ) as BehavioralSummary;
    const ok = list.transitions[0];
    expect(ok.output.type).toBe("response");
    if (ok.output.type === "response") {
      expect(JSON.stringify(ok.output.body)).toContain("orders");
    }
  });

  it("reads a pages handler through the response it was handed", () => {
    const legacy = summaries.find(
      (s) => routeOf(s) === "* /api/legacy",
    ) as BehavioralSummary;
    // The path is right and the statuses are right. There is no method,
    // because one export serves all of them, so this route does not pair with
    // a caller.
    expect(statusesOf(legacy)).toEqual([200, 405]);
  });
});
