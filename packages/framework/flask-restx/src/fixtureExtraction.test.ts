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

/** Inline rather than the shipped `@suss/framework-fastapi`, which has its own extraction test. */
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
        "BehaviorList.get",
        "BehaviorDetail.get",
        "InvoiceList.get",
        "InvoiceDetail.get",
        "ReportDetail.get",
        "ExportDetail.get",
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

  it("serves a namespace's routes under the path the namespace was constructed with", async () => {
    const { summaries } = await extractFixture();
    const detail = summaries.find(
      (s) => s.identity.name === "BehaviorDetail.get",
    );
    expect(detail?.identity.boundaryBinding?.semantics).toEqual({
      name: "rest",
      method: "GET",
      path: "/behaviors/{school_id}/{behavior_id}",
    });
  });

  it("reads an empty route path as the namespace's own path, parameter roles and all", async () => {
    const { summaries } = await extractFixture();
    const list = summaries.find((s) => s.identity.name === "BehaviorList.get");
    expect(list?.identity.boundaryBinding?.semantics).toEqual({
      name: "rest",
      method: "GET",
      path: "/behaviors/{school_id}",
    });
    expect(list?.inputs).toEqual([
      {
        type: "parameter",
        name: "school_id",
        position: 1,
        role: "pathParams",
        shape: null,
      },
    ]);
  });

  it("serves a namespace written with a trailing slash where the library serves it", async () => {
    const { summaries } = await extractFixture();
    const paths = ["InvoiceList.get", "InvoiceDetail.get"].map((name) => {
      const semantics = summaries.find((s) => s.identity.name === name)
        ?.identity.boundaryBinding?.semantics;
      return semantics?.name === "rest" ? semantics.path : undefined;
    });
    expect(paths).toEqual(["/invoices", "/invoices/{invoice_id}"]);
  });

  it("composes a namespace path written as a module constant", async () => {
    const { summaries } = await extractFixture();
    const report = summaries.find(
      (s) => s.identity.name === "ReportDetail.get",
    );
    expect(report?.identity.boundaryBinding?.semantics).toEqual({
      name: "rest",
      method: "GET",
      path: "/reports/{report_id}",
    });
  });

  it("classifies a path parameter under a path it worked out", async () => {
    const { summaries } = await extractFixture();
    const report = summaries.find(
      (s) => s.identity.name === "ReportDetail.get",
    );
    expect(report?.inputs).toEqual([
      {
        type: "parameter",
        name: "report_id",
        position: 1,
        role: "pathParams",
        shape: null,
      },
    ]);
  });

  it("names the path for a namespace mounted twice at the one place", async () => {
    const { summaries } = await extractFixture();
    const exported = summaries.find(
      (s) => s.identity.name === "ExportDetail.get",
    );
    expect(exported?.identity.boundaryBinding?.semantics).toEqual({
      name: "rest",
      method: "GET",
      path: "/exports/{export_id}",
    });
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
      // This path only exists once the namespace's own path is put in front
      // of the route's.
      consumer("listBehaviors", "GET", "/behaviors/{school_id}"),
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
        "listBehaviors<->BehaviorList.get",
      ].sort(),
    );

    expect(result.unmatched.consumers.map((c) => c.identity.name)).toEqual([
      "getNothing",
    ]);

    expect(result.unmatched.providers.length).toBeGreaterThan(0);
  });
});
