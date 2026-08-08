// fixtureExtraction.test.ts: the acceptance test for the Python
// adapter's v0 slice (docs/internal/proposals/language-adapters.md).
//
// Extracts over fixtures/python-webapp, a small invented fixture
// (sourced from nothing private) anchoring the shape the proposal's
// corpus measurement found: an internal wrapper module re-exporting
// flask-restx's route decorator, route files importing it (one
// aliased), and a FastAPI-style file with annotated parameters and a
// response model class. `pairSummaries` (the same pairing @suss/checker
// runs for same-language boundaries) buckets the extracted provider
// routes against hand-built consumer summaries by method and path
// alone, which is the existence-pairing acceptance bar the proposal
// names: nothing here depends on the consumer summaries having come
// from Python, so the same bucketing works across languages once both
// sides extract.
//
// The FastAPI-style file is read through the inline `fastapiPack`
// below rather than the shipped `@suss/framework-fastapi`, which has
// its own fixture and extraction test: depending on a sibling pack
// here would only re-test it.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { extractPythonProject, findPythonFiles } from "@suss/adapter-python";
import { restBinding } from "@suss/behavioral-ir";
import { pairSummaries } from "@suss/checker";

import { flaskRestxFramework } from "./index.js";

import type { PythonPack } from "@suss/adapter-python";
import type { BehavioralSummary } from "@suss/behavioral-ir";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);
const fixtureRoot = path.join(repoRoot, "fixtures", "python-webapp");

/**
 * Not the shipped `@suss/framework-fastapi`: an inline config proving
 * the same `decoratedFunctionRoute` mechanism (verb in the decorator's
 * own attribute name, `response_model` / `status_code` keywords)
 * covers both route shapes in one extraction, without a cross-pack
 * dependency on a sibling that has its own extraction test.
 */
const fastapiPack: PythonPack = {
  name: "fastapi-inline-test-pack",
  protocol: "http",
  discovery: [
    {
      type: "decoratedFunctionRoute",
      importModule: ["fastapi"],
      verbAttributeNames: {
        get: "GET",
        post: "POST",
        put: "PUT",
        delete: "DELETE",
        patch: "PATCH",
      },
      pathParamSyntax: "braces",
      annotatedClassIsRequestBody: true,
      defaultStatusCode: 200,
      responseModelKeyword: "response_model",
      statusCodeKeyword: "status_code",
    },
  ],
};

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
    packs: [
      flaskRestxFramework({ wrapperModules: ["myapp.wrappers.restx"] }),
      fastapiPack,
    ],
    roots: [fixtureRoot],
    workspaceRoot: repoRoot,
  });
}

describe("extraction over fixtures/python-webapp", () => {
  it("discovers every route across the wrapper's route files and the FastAPI file", async () => {
    const { summaries } = await extractFixture();
    expect(summaries.map((s) => s.identity.name).sort()).toEqual(
      [
        "TodoList.get",
        "TodoList.post",
        "OrderDetail.get",
        "OrderDetail.delete",
        "UserList.get",
        "read_item",
        "create_item",
      ].sort(),
    );
  });

  it("resolves the aliased import the same way as the direct one", async () => {
    const { summaries } = await extractFixture();
    const orderGet = summaries.find(
      (s) => s.identity.name === "OrderDetail.get",
    );
    expect(orderGet?.identity.boundaryBinding).toEqual({
      transport: "http",
      semantics: { name: "rest", method: "GET", path: "/orders/{order_id}" },
      recognition: "flask-restx",
    });
  });

  it("reads Flask's converter template into a canonical path claim with a path-parameter role", async () => {
    // The fixture writes the route the way Flask spells it,
    // `/orders/<int:order_id>`. The claim has to canonicalize to the
    // IR's brace form and classify `order_id` as a path parameter;
    // a reader that only understands braces leaves the path in Flask's
    // spelling and the parameter demoted to a query parameter, which
    // is the bug this pins.
    const { summaries } = await extractFixture();
    const orderGet = summaries.find(
      (s) => s.identity.name === "OrderDetail.get",
    );
    expect(orderGet?.identity.boundaryBinding?.semantics).toEqual({
      name: "rest",
      method: "GET",
      path: "/orders/{order_id}",
    });
    expect(orderGet?.inputs).toEqual([
      {
        type: "parameter",
        name: "order_id",
        position: 1,
        role: "pathParams",
        shape: null,
      },
    ]);
  });

  it("every discovered route is low-confidence: v0 reads no body", async () => {
    const { summaries } = await extractFixture();
    expect(summaries.every((s) => s.confidence.level === "low")).toBe(true);
  });

  it("pairs the extracted providers against hand-built consumer summaries by method and path", async () => {
    const { summaries } = await extractFixture();
    const consumers = [
      consumer("listTodos", "GET", "/todos"),
      consumer("getOrder", "GET", "/orders/{order_id}"),
      consumer("readItem", "GET", "/items/{item_id}"),
      consumer("getNothing", "GET", "/does-not-exist"),
    ];

    const result = pairSummaries([...summaries, ...consumers]);

    const pairedKeys = result.pairs
      .map((p) => `${p.consumer.identity.name}<->${p.provider.identity.name}`)
      .sort();
    expect(pairedKeys).toEqual(
      [
        "listTodos<->TodoList.get",
        "getOrder<->OrderDetail.get",
        "readItem<->read_item",
      ].sort(),
    );

    // The consumer with no matching route lands in unmatched, proving
    // pairing does bucket rather than pass everything through.
    expect(result.unmatched.consumers.map((c) => c.identity.name)).toEqual([
      "getNothing",
    ]);

    // Providers with no hand-built consumer (POST /todos, DELETE
    // /orders/{order_id}, GET /users, create_item) land unmatched too.
    expect(result.unmatched.providers.length).toBeGreaterThan(0);
  });
});
