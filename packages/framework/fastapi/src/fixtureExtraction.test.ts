// fixtureExtraction.test.ts: the acceptance test for the FastAPI pack
// (docs/internal/proposals/language-adapters.md, slice 3).
//
// Extracts over fixtures/python-fastapi, a small invented fixture
// (sourced from nothing private): plain routes on the app, a prefixed
// router the app mounts under a second prefix (the path a consumer
// calls appears in no single file), and the two abstentions the pack
// promises to keep loud, a route path built at runtime and a mount
// whose prefix is computed. `pairSummaries` (the same pairing
// @suss/checker runs for same-language boundaries) buckets the
// extracted provider routes against hand-built consumer summaries by
// method and path alone, so a composed router path pairs exactly like
// a written-out one, and an abstained route pairs with nothing.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { extractPythonProject, findPythonFiles } from "@suss/adapter-python";
import { restBinding } from "@suss/behavioral-ir";
import { pairSummaries } from "@suss/checker";

import { fastapiFramework } from "./index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);
const fixtureRoot = path.join(repoRoot, "fixtures", "python-fastapi");

function consumer(
  name: string,
  method: string,
  path_: string,
): BehavioralSummary {
  return {
    kind: "client",
    location: {
      file: "src/api-client.ts",
      range: { start: 0, end: 0 },
      exportName: null,
    },
    identity: {
      name,
      exportPath: null,
      boundaryBinding: restBinding({
        transport: "http",
        method,
        path: path_,
        recognition: "axios",
      }),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

async function extractFixture() {
  const files = findPythonFiles(fixtureRoot);
  return extractPythonProject({
    files,
    packs: [fastapiFramework()],
    roots: [fixtureRoot],
    workspaceRoot: repoRoot,
  });
}

function bindingOf(summaries: BehavioralSummary[], name: string) {
  return summaries.find((s) => s.identity.name === name)?.identity
    .boundaryBinding;
}

describe("extraction over fixtures/python-fastapi", () => {
  it("discovers every route, on the app and on both routers", async () => {
    const { summaries } = await extractFixture();
    expect(summaries.map((s) => s.identity.name).sort()).toEqual(
      [
        "health",
        "create_order",
        "report",
        "read_item",
        "create_item",
        "admin_stats",
      ].sort(),
    );
  });

  it("composes the mount prefix and the router's own prefix into the route path", async () => {
    const { summaries } = await extractFixture();
    expect(bindingOf(summaries, "read_item")).toEqual({
      transport: "http",
      semantics: {
        name: "rest",
        method: "GET",
        path: "/api/items/{item_id}",
      },
      recognition: "fastapi",
    });
    // The route path itself is empty; the composed prefixes are the
    // whole path.
    expect(bindingOf(summaries, "create_item")?.semantics).toEqual({
      name: "rest",
      method: "POST",
      path: "/api/items",
    });
  });

  it("reads response_model and status_code into the declared transition", async () => {
    const { summaries } = await extractFixture();
    const createItem = summaries.find((s) => s.identity.name === "create_item");
    const transition = createItem?.transitions[0];
    expect(transition?.output.type).toBe("response");
    expect(
      transition?.output.type === "response" && transition.output.statusCode,
    ).toEqual({ type: "literal", value: 201 });

    const payload = createItem?.inputs.find(
      (i) => i.type === "parameter" && i.name === "payload",
    );
    expect(payload?.type === "parameter" && payload.role).toBe("requestBody");
  });

  it("keeps the runtime-built path discovered by name, with no path and a stated gap", async () => {
    const { summaries } = await extractFixture();
    const report = summaries.find((s) => s.identity.name === "report");
    expect(report?.identity.boundaryBinding?.semantics).toEqual({
      name: "rest",
      method: "GET",
      path: null,
    });
    expect(
      report?.gaps.some(
        (gap) =>
          gap.type === "unreadOutcome" &&
          gap.description.includes("not a string literal"),
      ),
    ).toBe(true);
  });

  it("keeps the computed-prefix mount discovered by name, with no path and a stated gap", async () => {
    const { summaries } = await extractFixture();
    const adminStats = summaries.find((s) => s.identity.name === "admin_stats");
    expect(adminStats?.identity.boundaryBinding?.semantics).toEqual({
      name: "rest",
      method: "GET",
      path: null,
    });
    expect(
      adminStats?.gaps.some(
        (gap) =>
          gap.type === "unreadOutcome" &&
          gap.description.includes(
            "mounted with a prefix that is not a string literal",
          ),
      ),
    ).toBe(true);
  });

  it("pairs the extracted providers against hand-built consumer summaries by method and path", async () => {
    const { summaries } = await extractFixture();
    const consumers = [
      consumer("checkHealth", "GET", "/health"),
      consumer("readItem", "GET", "/api/items/{item_id}"),
      consumer("createItem", "POST", "/api/items"),
      consumer("getNothing", "GET", "/does-not-exist"),
    ];

    const result = pairSummaries([...summaries, ...consumers]);

    const pairedKeys = result.pairs
      .map((p) => `${p.consumer.identity.name}<->${p.provider.identity.name}`)
      .sort();
    expect(pairedKeys).toEqual(
      [
        "checkHealth<->health",
        "readItem<->read_item",
        "createItem<->create_item",
      ].sort(),
    );

    // The consumer with no matching route lands in unmatched, proving
    // pairing does bucket rather than pass everything through.
    expect(result.unmatched.consumers.map((c) => c.identity.name)).toEqual([
      "getNothing",
    ]);

    // The provider nobody calls (POST /orders) lands unmatched.
    expect(result.unmatched.providers.map((p) => p.identity.name)).toContain(
      "create_order",
    );

    // The abstained routes carry no path, so they take no part in
    // pairing at all rather than pairing with a guess.
    expect(
      result.unmatched.unpairable
        .map((u) => `${u.summary.identity.name}:${u.reason}`)
        .sort(),
    ).toEqual(["admin_stats:unnamedBoundary", "report:unnamedBoundary"]);
  });
});
