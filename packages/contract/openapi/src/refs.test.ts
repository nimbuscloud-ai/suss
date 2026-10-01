import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { readHttpMetadata, safeParseSummaries } from "@suss/behavioral-ir";

import { openApiFileToSummaries, openApiToSummaries } from "./index.js";

import type { BehavioralSummary, TypeShape } from "@suss/behavioral-ir";
import type { OpenApiSpec } from "./index.js";

const SPLIT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
  "split",
  "openapi.yaml",
);

function byName(
  summaries: BehavioralSummary[],
): Map<string, BehavioralSummary> {
  return new Map(summaries.map((s) => [s.identity.name, s]));
}

function inputsOf(summary: BehavioralSummary | undefined): string[] {
  return (summary?.inputs ?? []).map((input) =>
    input.type === "parameter" ? `${input.role}:${input.name}` : input.type,
  );
}

function bodyAt(
  summary: BehavioralSummary | undefined,
  status: number,
): TypeShape | null | undefined {
  const transition = summary?.transitions.find(
    (t) =>
      t.output.type === "response" &&
      t.output.statusCode?.type === "literal" &&
      t.output.statusCode.value === status,
  );
  return transition?.output.type === "response"
    ? transition.output.body
    : undefined;
}

function readSplit(): { summaries: BehavioralSummary[]; unread: string[] } {
  const unread: string[] = [];
  const summaries = openApiFileToSummaries(SPLIT, {
    onUnread: (message) => unread.push(message),
  });
  return { summaries, unread };
}

describe("a document split across files", () => {
  it("reads each path item written in another file", () => {
    const { summaries, unread } = readSplit();
    expect(summaries.map((s) => s.identity.name).sort()).toEqual([
      "createOrder",
      "getOrder",
      "listOrders",
    ]);
    expect(unread).toEqual([]);
  });

  it("resolves a parameter ref back into the root document, and through it to a third file", () => {
    const named = byName(readSplit().summaries);
    expect(inputsOf(named.get("getOrder"))).toEqual(["pathParams:id"]);
    expect(inputsOf(named.get("listOrders"))).toEqual(["queryParams:limit"]);
  });

  it("resolves a response ref and a request body ref", () => {
    const named = byName(readSplit().summaries);
    expect(bodyAt(named.get("getOrder"), 404)).toEqual({
      type: "record",
      properties: { message: { type: "text" } },
    });
    const body = named
      .get("createOrder")
      ?.inputs.find(
        (input) => input.type === "parameter" && input.role === "requestBody",
      );
    expect(body !== undefined && "shape" in body ? body.shape : null).toEqual({
      type: "record",
      properties: {
        customer: {
          type: "record",
          properties: { name: { type: "text" } },
        },
      },
    });
  });

  it("resolves a schema in another file, relative to the file that refers to it", () => {
    const named = byName(readSplit().summaries);
    const order = bodyAt(named.get("getOrder"), 200);
    expect(order?.type).toBe("record");
    if (order?.type !== "record") {
      return;
    }
    expect(order.properties.id).toEqual({ type: "text" });
    expect(order.properties.customer).toEqual({
      type: "union",
      variants: [
        { type: "record", properties: { name: { type: "text" } } },
        { type: "undefined" },
      ],
    });
    // The order refers to itself, so the recursion stops at a placeholder.
    expect(order.properties.replaces).toEqual({
      type: "union",
      variants: [
        { type: "ref", name: "schemas/order.yaml" },
        { type: "undefined" },
      ],
    });
  });

  it("keeps the declared contract's statuses for a response written by ref", () => {
    const getOrder = byName(readSplit().summaries).get("getOrder");
    if (getOrder === undefined) {
      throw new Error("expected getOrder");
    }
    const contract = readHttpMetadata(getOrder)?.declaredContract;
    expect(contract?.responses.map((r) => r.statusCode)).toEqual([200, 404]);
  });

  it("writes summaries the checker's own schema accepts", () => {
    const written = JSON.parse(
      JSON.stringify(readSplit().summaries),
    ) as unknown;
    const result = safeParseSummaries(written);
    expect(result.error?.issues ?? []).toEqual([]);
  });

  it("says which file a ref points to that could not be read, once", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "suss-openapi-split-"));
    const file = path.join(tmp, "openapi.yaml");
    fs.writeFileSync(
      file,
      [
        "openapi: 3.0.3",
        "paths:",
        "  /orders:",
        "    $ref: ./paths/missing.yaml",
        "  /accounts:",
        "    $ref: ./paths/missing.yaml#/accounts",
        "  /ping:",
        "    get:",
        "      operationId: ping",
        "      parameters:",
        "        - $ref: '#/components/parameters/Nope'",
        "      responses:",
        "        '200':",
        "          description: ok",
      ].join("\n"),
    );
    const unread: string[] = [];
    try {
      const summaries = openApiFileToSummaries(file, {
        onUnread: (message) => unread.push(message),
      });
      expect(summaries.map((s) => s.identity.name)).toEqual(["ping"]);
      expect(summaries[0].inputs).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true });
    }
    expect(unread).toHaveLength(2);
    expect(unread[0]).toContain("could not read paths/missing.yaml");
    expect(unread[1]).toContain(
      "$ref #/components/parameters/Nope points at nothing",
    );
  });

  it("counts the dangling refs past the first ten instead of listing them", () => {
    const parameters = Array.from({ length: 12 }, (_, i) => ({
      $ref: `#/components/parameters/Missing${i}`,
    }));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "suss-openapi-split-"));
    const file = path.join(tmp, "openapi.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        openapi: "3.0.3",
        paths: { "/x": { get: { parameters, responses: {} } } },
      }),
    );
    const unread: string[] = [];
    try {
      openApiFileToSummaries(file, { onUnread: (m) => unread.push(m) });
    } finally {
      fs.rmSync(tmp, { recursive: true });
    }
    expect(unread).toHaveLength(11);
    expect(unread[10]).toContain("2 more $refs point at nothing");
  });

  it("reports a referenced file that does not parse", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "suss-openapi-split-"));
    const file = path.join(tmp, "openapi.yaml");
    fs.writeFileSync(file, "openapi: 3.0.3\npaths:\n  /a:\n    $ref: a.json\n");
    fs.writeFileSync(path.join(tmp, "a.json"), "{ not json");
    const unread: string[] = [];
    try {
      expect(
        openApiFileToSummaries(file, { onUnread: (m) => unread.push(m) }),
      ).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true });
    }
    expect(unread).toHaveLength(1);
    expect(unread[0]).toContain("could not read a.json");
  });
});

describe("a document whose maps are each one ref to an index file", () => {
  const INDEXED = path.join(
    path.dirname(SPLIT),
    "..",
    "indexed",
    "openapi.yaml",
  );

  function readIndexed(): {
    named: Map<string, BehavioralSummary>;
    unread: string[];
  } {
    const unread: string[] = [];
    const summaries = openApiFileToSummaries(INDEXED, {
      onUnread: (message) => unread.push(message),
    });
    return { named: byName(summaries), unread };
  }

  it("reads the paths map and each operation written by ref", () => {
    const { named, unread } = readIndexed();
    expect([...named.keys()].sort()).toEqual(["deleteAccount", "getAccount"]);
    expect(unread).toEqual([]);
  });

  it("reads a root component through a pointer written in a path file", () => {
    const { named } = readIndexed();
    expect(inputsOf(named.get("getAccount"))).toEqual([
      "pathParams:account_id",
    ]);
    expect(inputsOf(named.get("deleteAccount"))).toEqual([
      "pathParams:account_id",
    ]);
    expect(bodyAt(named.get("getAccount"), 200)).toEqual({
      type: "record",
      properties: { name: { type: "text" } },
    });
  });

  it("gives a schema key with nothing after it an unknown body", () => {
    const { named } = readIndexed();
    expect(bodyAt(named.get("getAccount"), 404)).toEqual({ type: "unknown" });
  });

  it("stops a pointer that follows refs in a loop", () => {
    const spec = {
      openapi: "3.0.3",
      components: {
        parameters: { $ref: "#/components/parameters" },
      },
      paths: {
        "/x": {
          get: {
            operationId: "x",
            parameters: [{ $ref: "#/components/parameters/id" }],
            responses: {},
          },
        },
      },
    } as unknown as OpenApiSpec;
    expect(openApiToSummaries(spec)[0].inputs).toEqual([]);
  });
});

describe("refs inside one document", () => {
  it("resolves an OpenAPI 3 parameter, request body and response written by ref", () => {
    const spec: OpenApiSpec = {
      openapi: "3.1.0",
      paths: {
        "/accounts/{account_id}": {
          parameters: [{ $ref: "#/components/parameters/account_id" }],
          post: {
            operationId: "updateAccount",
            requestBody: { $ref: "#/components/requestBodies/Account" },
            responses: {
              "200": { $ref: "#/components/responses/Account" },
            },
          },
        },
      },
      components: {
        parameters: {
          account_id: {
            name: "account_id",
            in: "path",
            required: true,
            schema: { type: "integer" },
          },
        },
        requestBodies: {
          Account: {
            content: { "application/json": { schema: { type: "string" } } },
          },
        },
        responses: {
          Account: {
            description: "ok",
            content: { "application/json": { schema: { type: "boolean" } } },
          },
        },
      },
    };
    const [summary] = openApiToSummaries(spec);
    expect(inputsOf(summary)).toEqual([
      "pathParams:account_id",
      "requestBody:body",
    ]);
    expect(bodyAt(summary, 200)).toEqual({ type: "boolean" });
    const written = JSON.parse(JSON.stringify([summary])) as unknown;
    expect(safeParseSummaries(written).success).toBe(true);
  });

  it("resolves a Swagger 2.0 parameter and response written by ref", () => {
    const spec: OpenApiSpec = {
      swagger: "2.0",
      paths: {
        "/orders": {
          get: {
            operationId: "listOrders",
            parameters: [{ $ref: "#/parameters/page" }],
            responses: { "404": { $ref: "#/responses/NotFound" } },
          },
        },
      },
      parameters: { page: { name: "page", in: "query", type: "integer" } },
      responses: {
        NotFound: { description: "missing", schema: { type: "string" } },
      },
    };
    const [summary] = openApiToSummaries(spec);
    expect(inputsOf(summary)).toEqual(["queryParams:page"]);
    expect(bodyAt(summary, 404)).toEqual({ type: "text" });
  });

  it("follows a path item ref whose pointer escapes a slash", () => {
    const spec: OpenApiSpec = {
      openapi: "3.0.3",
      paths: {
        "/orders": {
          get: { operationId: "listOrders", responses: {} },
        },
        "/v2/orders": { $ref: "#/paths/~1orders" },
      },
    };
    expect(openApiToSummaries(spec).map((s) => s.identity.name)).toEqual([
      "listOrders",
      "listOrders",
    ]);
  });

  it("keeps a response's status when its ref points at nothing", () => {
    const spec: OpenApiSpec = {
      openapi: "3.0.3",
      paths: {
        "/x": {
          get: {
            operationId: "x",
            responses: { "401": { $ref: "#/components/responses/Nope" } },
          },
        },
      },
    };
    const [summary] = openApiToSummaries(spec);
    expect(bodyAt(summary, 401)).toBeNull();
  });

  it("stops a ref chain that loops", () => {
    const spec: OpenApiSpec = {
      openapi: "3.0.3",
      paths: {
        "/a": { $ref: "#/paths/~1b" },
        "/b": { $ref: "#/paths/~1a" },
      },
    };
    expect(openApiToSummaries(spec)).toEqual([]);
  });

  it("leaves a ref to another file unresolved in a document read from memory", () => {
    const spec: OpenApiSpec = {
      openapi: "3.0.3",
      paths: {
        "/x": { $ref: "./paths/x.yaml" },
        "/y": {
          get: {
            operationId: "y",
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: { $ref: "https://example.com/schemas/y.json" },
                  },
                },
              },
            },
          },
        },
      },
    };
    const summaries = openApiToSummaries(spec);
    expect(summaries.map((s) => s.identity.name)).toEqual(["y"]);
    expect(bodyAt(summaries[0], 200)).toEqual({
      type: "ref",
      name: "https://example.com/schemas/y.json",
    });
  });
});
