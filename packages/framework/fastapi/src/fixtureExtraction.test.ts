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
  it("discovers every route, on the app and on both routers, and the dependency around one of them", async () => {
    const { summaries } = await extractFixture();
    expect(summaries.map((s) => s.identity.name).sort()).toEqual(
      [
        "health",
        "create_order",
        "report",
        "read_item",
        "create_item",
        "current_user",
        "read_stock",
        "admin_stats",
      ].sort(),
    );
  });

  it("gives the route that raises one transition per outcome, each with its own condition", async () => {
    const { summaries } = await extractFixture();
    const readStock = summaries.find((s) => s.identity.name === "read_stock");
    expect(
      readStock?.transitions.map((transition) => [
        transition.output.type === "response"
          ? transition.output.statusCode
          : transition.output.type,
        transition.conditions.map((condition) => condition.type),
      ]),
    ).toEqual([
      [{ type: "literal", value: 404 }, ["comparison"]],
      [{ type: "literal", value: 200 }, ["negation"]],
    ]);
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
    // This route's own path is empty, so the composed prefixes are all
    // of it.
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

    const injected = createItem?.inputs.find(
      (input) => input.type === "parameter" && input.name === "user",
    );
    expect(injected?.type === "parameter" && injected.role).toBe(null);
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

    expect(result.unmatched.consumers.map((c) => c.identity.name)).toEqual([
      "getNothing",
    ]);

    expect(result.unmatched.providers.map((p) => p.identity.name)).toContain(
      "create_order",
    );

    expect(
      result.unmatched.unpairable
        .map((u) => `${u.summary.identity.name}:${u.reason}`)
        .sort(),
    ).toEqual([
      "admin_stats:unnamedBoundary",
      "current_user:noBoundary",
      "report:unnamedBoundary",
    ]);
  });
});
