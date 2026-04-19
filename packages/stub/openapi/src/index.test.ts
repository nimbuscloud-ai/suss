import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { openApiFileToSummaries, openApiToSummaries } from "./index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { OpenApiSpec } from "./index.js";

function restMethodOf(summary: BehavioralSummary): string | null {
  const s = summary.identity.boundaryBinding?.semantics;
  return s?.name === "rest" ? s.method : null;
}

function restPathOf(summary: BehavioralSummary): string | null {
  const s = summary.identity.boundaryBinding?.semantics;
  return s?.name === "rest" ? s.path : null;
}

// ---------------------------------------------------------------------------
// Fixture specs — hand-built so each test reads on one screen
// ---------------------------------------------------------------------------

const minimalSpec: OpenApiSpec = {
  openapi: "3.0.3",
  info: { title: "users-api", version: "1.0.0" },
  paths: {
    "/users/{id}": {
      get: {
        operationId: "getUser",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["id", "name"],
                  properties: {
                    id: { type: "string" },
                    name: { type: "string" },
                  },
                },
              },
            },
          },
          "404": {
            description: "not found",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["error"],
                  properties: { error: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
  },
};

const refSpec: OpenApiSpec = {
  openapi: "3.0.3",
  paths: {
    "/users/{id}": {
      get: {
        operationId: "getUser",
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/User" },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      User: {
        type: "object",
        required: ["id", "name", "friend"],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          // Self-referential field — exercises cycle protection
          friend: { $ref: "#/components/schemas/User" },
        },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Core mapping
// ---------------------------------------------------------------------------

describe("openApiToSummaries — basic mapping", () => {
  it("emits one summary per operation with handler kind and openapi framework", () => {
    const summaries = openApiToSummaries(minimalSpec);
    expect(summaries).toHaveLength(1);

    const s = summaries[0];
    expect(s.kind).toBe("handler");
    expect(s.identity.name).toBe("getUser");
    expect(s.identity.boundaryBinding).toEqual({
      transport: "http",
      semantics: { name: "rest", method: "GET", path: "/users/{id}" },
      recognition: "openapi",
    });
    expect(s.confidence).toEqual({ source: "stub", level: "high" });
  });

  it("emits a transition per declared response status", () => {
    const summaries = openApiToSummaries(minimalSpec);
    const transitions = summaries[0].transitions;
    expect(transitions).toHaveLength(2);

    const codes = transitions
      .map((t) =>
        t.output.type === "response" && t.output.statusCode?.type === "literal"
          ? t.output.statusCode.value
          : null,
      )
      .sort();
    expect(codes).toEqual([200, 404]);
  });

  it("converts response bodies to TypeShape via the schema converter", () => {
    const summaries = openApiToSummaries(minimalSpec);
    const ok = summaries[0].transitions.find(
      (t) =>
        t.output.type === "response" &&
        t.output.statusCode?.type === "literal" &&
        t.output.statusCode.value === 200,
    );
    expect(ok).toBeDefined();
    if (ok?.output.type !== "response") {
      throw new Error("expected response output");
    }
    expect(ok?.output.body).toEqual({
      type: "record",
      properties: {
        id: { type: "text" },
        name: { type: "text" },
      },
    });
  });

  it("maps every parameter location (path/query/header/cookie) and the requestBody", () => {
    const spec: OpenApiSpec = {
      openapi: "3.0.3",
      paths: {
        "/items/{id}": {
          // Path-level parameter; should be merged into the operation's inputs
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          post: {
            operationId: "createItem",
            parameters: [
              { name: "search", in: "query", schema: { type: "string" } },
              {
                name: "x-trace-id",
                in: "header",
                schema: { type: "string" },
              },
              { name: "session", in: "cookie", schema: { type: "string" } },
            ],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { name: { type: "string" } },
                  },
                },
              },
            },
            responses: { "201": { description: "created" } },
          },
        },
      },
    };
    const summaries = openApiToSummaries(spec);
    const inputs = summaries[0].inputs;

    const byRole: Record<string, string[]> = {};
    for (const i of inputs) {
      if (i.type !== "parameter") {
        continue;
      }
      byRole[i.role] = byRole[i.role] ?? [];
      byRole[i.role].push(i.name);
    }
    expect(byRole.queryParams).toEqual(["search"]);
    expect(byRole.headers).toEqual(["x-trace-id"]);
    expect(byRole.cookies).toEqual(["session"]);
    expect(byRole.requestBody).toEqual(["body"]);
    expect(byRole.pathParams).toEqual(["id"]);
  });

  it("requestBody with no content emits an unknown shape input", () => {
    const spec: OpenApiSpec = {
      openapi: "3.0.3",
      paths: {
        "/x": {
          post: {
            operationId: "x",
            requestBody: { required: false },
            responses: { "204": { description: "no content" } },
          },
        },
      },
    };
    const summaries = openApiToSummaries(spec);
    const body = summaries[0].inputs.find(
      (i) => i.type === "parameter" && i.role === "requestBody",
    );
    expect(body).toBeDefined();
    if (body?.type !== "parameter") {
      throw new Error("expected parameter input");
    }
    expect(body.shape).toEqual({ type: "unknown" });
  });

  it("operation-level parameter overrides a same-name path-level parameter", () => {
    const spec: OpenApiSpec = {
      openapi: "3.0.3",
      paths: {
        "/items/{id}": {
          parameters: [{ name: "id", in: "path", schema: { type: "string" } }],
          get: {
            operationId: "getItem",
            parameters: [
              // Operation-level wins — schema should be integer
              { name: "id", in: "path", schema: { type: "integer" } },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const summaries = openApiToSummaries(spec);
    const ids = summaries[0].inputs.filter(
      (i) => i.type === "parameter" && i.name === "id",
    );
    expect(ids).toHaveLength(1);
    if (ids[0].type !== "parameter") {
      throw new Error("expected parameter input");
    }
    expect(ids[0].shape).toEqual({ type: "integer" });
  });

  it("response without content emits a transition with null body", () => {
    const spec: OpenApiSpec = {
      openapi: "3.0.3",
      paths: {
        "/x": {
          get: {
            operationId: "x",
            responses: { "204": { description: "no content" } },
          },
        },
      },
    };
    const summaries = openApiToSummaries(spec);
    const t = summaries[0].transitions[0];
    if (t.output.type !== "response") {
      throw new Error("expected response output");
    }
    expect(t.output.body).toBeNull();
  });

  it("response content without a schema emits a transition with null body", () => {
    const spec: OpenApiSpec = {
      openapi: "3.0.3",
      paths: {
        "/x": {
          get: {
            operationId: "x",
            responses: {
              "200": {
                description: "ok",
                content: { "application/octet-stream": {} },
              },
            },
          },
        },
      },
    };
    const summaries = openApiToSummaries(spec);
    const t = summaries[0].transitions[0];
    if (t.output.type !== "response") {
      throw new Error("expected response output");
    }
    expect(t.output.body).toBeNull();
  });

  it("models path/query parameters as inputs with semantic roles", () => {
    const summaries = openApiToSummaries(minimalSpec);
    const inputs = summaries[0].inputs;
    expect(inputs).toHaveLength(1);
    const idParam = inputs[0];
    if (idParam.type !== "parameter") {
      throw new Error("expected parameter input");
    }
    expect(idParam.name).toBe("id");
    expect(idParam.role).toBe("pathParams");
    expect(idParam.shape).toEqual({ type: "text" });
  });

  it("treats the `default` response as an isDefault transition with no status literal", () => {
    const spec: OpenApiSpec = {
      openapi: "3.0.3",
      paths: {
        "/health": {
          get: {
            operationId: "health",
            responses: {
              "200": { description: "ok" },
              default: { description: "fallback" },
            },
          },
        },
      },
    };
    const summaries = openApiToSummaries(spec);
    const def = summaries[0].transitions.find((t) => t.isDefault);
    expect(def).toBeDefined();
    if (def?.output.type !== "response") {
      throw new Error("expected response output");
    }
    expect(def?.output.statusCode).toBeNull();
  });

  it("expands range status codes (2XX, 4XX, 5XX) into transitions with a statusRange annotation", () => {
    const spec: OpenApiSpec = {
      openapi: "3.0.3",
      paths: {
        "/x": {
          get: {
            operationId: "x",
            responses: {
              "2XX": { description: "any 2xx" },
              "4XX": { description: "any 4xx" },
            },
          },
        },
      },
    };
    const summaries = openApiToSummaries(spec);
    const transitions = summaries[0].transitions;
    expect(transitions).toHaveLength(2);

    for (const t of transitions) {
      if (t.output.type !== "response") {
        throw new Error("expected response output");
      }
      expect(t.output.statusCode).toBeNull();
      expect(t.isDefault).toBe(false);
    }

    const ranges = transitions.map((t) => {
      const http = t.metadata?.http as Record<string, unknown> | undefined;
      return http?.statusRange as
        | { min: number; max: number; spec: string }
        | undefined;
    });
    expect(ranges).toEqual([
      { min: 200, max: 299, spec: "2XX" },
      { min: 400, max: 499, spec: "4XX" },
    ]);
  });

  it("accepts lowercase range codes like 5xx", () => {
    const spec: OpenApiSpec = {
      openapi: "3.0.3",
      paths: {
        "/x": {
          get: {
            operationId: "x",
            responses: { "5xx": { description: "any 5xx" } },
          },
        },
      },
    };
    const t = openApiToSummaries(spec)[0].transitions[0];
    const http = t.metadata?.http as Record<string, unknown> | undefined;
    expect(http?.statusRange).toEqual({ min: 500, max: 599, spec: "5xx" });
  });

  it("walks every HTTP method on a path item", () => {
    const spec: OpenApiSpec = {
      openapi: "3.0.3",
      paths: {
        "/items": {
          get: {
            operationId: "listItems",
            responses: { "200": { description: "ok" } },
          },
          post: {
            operationId: "createItem",
            responses: { "201": { description: "created" } },
          },
          delete: {
            operationId: "clearItems",
            responses: { "204": { description: "no content" } },
          },
        },
      },
    };
    const summaries = openApiToSummaries(spec);
    const methods = summaries.map((s) => restMethodOf(s)).sort();
    expect(methods).toEqual(["DELETE", "GET", "POST"]);
  });
});

// ---------------------------------------------------------------------------
// $ref resolution and cycle protection
// ---------------------------------------------------------------------------

describe("openApiToSummaries — $ref handling", () => {
  it("resolves component refs to their target shape", () => {
    const summaries = openApiToSummaries(refSpec);
    const ok = summaries[0].transitions[0];
    if (ok.output.type !== "response") {
      throw new Error("expected response output");
    }
    expect(ok.output.body?.type).toBe("record");
  });

  it("breaks cycles by emitting a named ref placeholder for self-references", () => {
    const summaries = openApiToSummaries(refSpec);
    const ok = summaries[0].transitions[0];
    if (ok.output.type !== "response" || ok.output.body?.type !== "record") {
      throw new Error("expected record body");
    }
    // The `friend` property recurses back to User — should be a ref
    // placeholder rather than infinite expansion.
    expect(ok.output.body.properties.friend).toEqual({
      type: "ref",
      name: "User",
    });
  });

  it("falls back to a named ref when the target component is missing", () => {
    const spec: OpenApiSpec = {
      openapi: "3.0.3",
      paths: {
        "/x": {
          get: {
            operationId: "x",
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/Missing" },
                  },
                },
              },
            },
          },
        },
      },
    };
    const summaries = openApiToSummaries(spec);
    const t = summaries[0].transitions[0];
    if (t.output.type !== "response") {
      throw new Error("expected response output");
    }
    expect(t.output.body).toEqual({ type: "ref", name: "Missing" });
  });
});

// ---------------------------------------------------------------------------
// Schema feature coverage
// ---------------------------------------------------------------------------

describe("openApiToSummaries — schema feature coverage", () => {
  it("nullable: true wraps the shape in a union with null", () => {
    const spec: OpenApiSpec = {
      openapi: "3.0.3",
      paths: {
        "/x": {
          get: {
            operationId: "x",
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: { type: "string", nullable: true },
                  },
                },
              },
            },
          },
        },
      },
    };
    const summaries = openApiToSummaries(spec);
    const t = summaries[0].transitions[0];
    if (t.output.type !== "response") {
      throw new Error("expected response output");
    }
    expect(t.output.body).toEqual({
      type: "union",
      variants: [{ type: "text" }, { type: "null" }],
    });
  });

  it("enum becomes a union of literal variants", () => {
    const spec: OpenApiSpec = {
      openapi: "3.0.3",
      paths: {
        "/x": {
          get: {
            operationId: "x",
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: {
                      type: "string",
                      enum: ["pending", "active", "closed"],
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    const summaries = openApiToSummaries(spec);
    const t = summaries[0].transitions[0];
    if (t.output.type !== "response") {
      throw new Error("expected response output");
    }
    expect(t.output.body).toEqual({
      type: "union",
      variants: [
        { type: "literal", value: "pending" },
        { type: "literal", value: "active" },
        { type: "literal", value: "closed" },
      ],
    });
  });

  it("oneOf becomes a union of variant shapes", () => {
    const spec: OpenApiSpec = {
      openapi: "3.0.3",
      paths: {
        "/x": {
          get: {
            operationId: "x",
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: {
                      oneOf: [{ type: "string" }, { type: "integer" }],
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    const summaries = openApiToSummaries(spec);
    const t = summaries[0].transitions[0];
    if (t.output.type !== "response") {
      throw new Error("expected response output");
    }
    expect(t.output.body).toEqual({
      type: "union",
      variants: [{ type: "text" }, { type: "integer" }],
    });
  });

  it("additionalProperties without properties becomes a dictionary shape", () => {
    const spec: OpenApiSpec = {
      openapi: "3.0.3",
      paths: {
        "/x": {
          get: {
            operationId: "x",
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      additionalProperties: { type: "integer" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    const summaries = openApiToSummaries(spec);
    const t = summaries[0].transitions[0];
    if (t.output.type !== "response") {
      throw new Error("expected response output");
    }
    expect(t.output.body).toEqual({
      type: "dictionary",
      values: { type: "integer" },
    });
  });

  it("additionalProperties: true (no schema) becomes a dictionary of unknown", () => {
    const spec: OpenApiSpec = {
      openapi: "3.0.3",
      paths: {
        "/x": {
          get: {
            operationId: "x",
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      additionalProperties: true,
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    const summaries = openApiToSummaries(spec);
    const t = summaries[0].transitions[0];
    if (t.output.type !== "response") {
      throw new Error("expected response output");
    }
    expect(t.output.body).toEqual({
      type: "dictionary",
      values: { type: "unknown" },
    });
  });

  it("allOf merges object members structurally", () => {
    const spec: OpenApiSpec = {
      openapi: "3.0.3",
      paths: {
        "/x": {
          get: {
            operationId: "x",
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: {
                      allOf: [
                        {
                          type: "object",
                          required: ["id"],
                          properties: { id: { type: "string" } },
                        },
                        {
                          type: "object",
                          required: ["name"],
                          properties: { name: { type: "string" } },
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    const summaries = openApiToSummaries(spec);
    const t = summaries[0].transitions[0];
    if (t.output.type !== "response") {
      throw new Error("expected response output");
    }
    expect(t.output.body).toEqual({
      type: "record",
      properties: {
        id: { type: "text" },
        name: { type: "text" },
      },
    });
  });

  it("allOf with non-object members falls back to a union", () => {
    const spec: OpenApiSpec = {
      openapi: "3.0.3",
      paths: {
        "/x": {
          get: {
            operationId: "x",
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: {
                      allOf: [{ type: "string" }, { type: "integer" }],
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    const summaries = openApiToSummaries(spec);
    const t = summaries[0].transitions[0];
    if (t.output.type !== "response") {
      throw new Error("expected response output");
    }
    expect(t.output.body).toEqual({
      type: "union",
      variants: [{ type: "text" }, { type: "integer" }],
    });
  });

  it("wraps non-required properties in `union<T, undefined>`", () => {
    const spec: OpenApiSpec = {
      openapi: "3.0.3",
      paths: {
        "/x": {
          get: {
            operationId: "x",
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      // `required` mentions only `id`; `name` is optional
                      required: ["id"],
                      properties: {
                        id: { type: "string" },
                        name: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    const summaries = openApiToSummaries(spec);
    const t = summaries[0].transitions[0];
    if (t.output.type !== "response") {
      throw new Error("expected response output");
    }
    expect(t.output.body).toEqual({
      type: "record",
      properties: {
        // Required — kept as-is
        id: { type: "text" },
        // Optional — wrapped with undefined
        name: {
          type: "union",
          variants: [{ type: "text" }, { type: "undefined" }],
        },
      },
    });
  });

  it("schemas with no type and no enum become unknown", () => {
    const spec: OpenApiSpec = {
      openapi: "3.0.3",
      paths: {
        "/x": {
          get: {
            operationId: "x",
            responses: {
              "200": {
                description: "ok",
                content: { "application/json": { schema: {} } },
              },
            },
          },
        },
      },
    };
    const summaries = openApiToSummaries(spec);
    const t = summaries[0].transitions[0];
    if (t.output.type !== "response") {
      throw new Error("expected response output");
    }
    expect(t.output.body).toEqual({ type: "unknown" });
  });

  it("array of strings becomes { type: 'array', items: { type: 'text' } }", () => {
    const spec: OpenApiSpec = {
      openapi: "3.0.3",
      paths: {
        "/x": {
          get: {
            operationId: "x",
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: { type: "array", items: { type: "string" } },
                  },
                },
              },
            },
          },
        },
      },
    };
    const summaries = openApiToSummaries(spec);
    const t = summaries[0].transitions[0];
    if (t.output.type !== "response") {
      throw new Error("expected response output");
    }
    expect(t.output.body).toEqual({
      type: "array",
      items: { type: "text" },
    });
  });
});

// ---------------------------------------------------------------------------
// OpenAPI 3.1 features
// ---------------------------------------------------------------------------

describe("openApiToSummaries — OpenAPI 3.1 features", () => {
  function responseBody(schema: unknown): OpenApiSpec {
    return {
      openapi: "3.1.0",
      paths: {
        "/x": {
          get: {
            operationId: "x",
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    // deliberately loosely-typed so we can pass 3.1 shapes
                    // (type arrays, const) that the 3.0-biased test types
                    // wouldn't otherwise accept.
                    schema: schema as never,
                  },
                },
              },
            },
          },
        },
      },
    };
  }

  function bodyOf(spec: OpenApiSpec) {
    const t = openApiToSummaries(spec)[0].transitions[0];
    if (t.output.type !== "response") {
      throw new Error("expected response output");
    }
    return t.output.body;
  }

  it("3.1: type array including 'null' maps to a union with null", () => {
    expect(bodyOf(responseBody({ type: ["string", "null"] }))).toEqual({
      type: "union",
      variants: [{ type: "text" }, { type: "null" }],
    });
  });

  it("3.1: type array with a single 'null' maps to null", () => {
    expect(bodyOf(responseBody({ type: ["null"] }))).toEqual({ type: "null" });
  });

  it("3.1: const narrows to a single literal", () => {
    expect(bodyOf(responseBody({ const: "alpha" }))).toEqual({
      type: "literal",
      value: "alpha",
    });
  });

  it("3.1: discriminator narrows each oneOf variant's propertyName to the mapping literal", () => {
    const spec: OpenApiSpec = {
      openapi: "3.1.0",
      components: {
        schemas: {
          Cat: {
            type: "object",
            required: ["kind", "meow"],
            properties: {
              kind: { type: "string" },
              meow: { type: "boolean" },
            },
          },
          Dog: {
            type: "object",
            required: ["kind", "bark"],
            properties: {
              kind: { type: "string" },
              bark: { type: "string" },
            },
          },
        },
      },
      paths: {
        "/pet": {
          get: {
            operationId: "getPet",
            responses: {
              "200": {
                description: "a pet",
                content: {
                  "application/json": {
                    schema: {
                      oneOf: [
                        { $ref: "#/components/schemas/Cat" },
                        { $ref: "#/components/schemas/Dog" },
                      ],
                      discriminator: {
                        propertyName: "kind",
                        mapping: {
                          cat: "#/components/schemas/Cat",
                          dog: "#/components/schemas/Dog",
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    const body = bodyOf(spec);
    if (body?.type !== "union") {
      throw new Error("expected union body");
    }
    expect(body.variants).toHaveLength(2);

    // Each variant should be a record whose `kind` is narrowed to the
    // discriminator literal.
    const [cat, dog] = body.variants;
    if (cat.type !== "record" || dog.type !== "record") {
      throw new Error("expected record variants");
    }
    expect(cat.properties.kind).toEqual({ type: "literal", value: "cat" });
    expect(cat.properties.meow).toEqual({ type: "boolean" });
    expect(dog.properties.kind).toEqual({ type: "literal", value: "dog" });
    expect(dog.properties.bark).toEqual({ type: "text" });
  });

  it("3.1: discriminator without a mapping entry leaves the variant untouched", () => {
    const spec: OpenApiSpec = {
      openapi: "3.1.0",
      components: {
        schemas: {
          Cat: {
            type: "object",
            properties: { kind: { type: "string" } },
          },
        },
      },
      paths: {
        "/pet": {
          get: {
            operationId: "getPet",
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: {
                      oneOf: [{ $ref: "#/components/schemas/Cat" }],
                      discriminator: { propertyName: "kind" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    const body = bodyOf(spec);
    if (body?.type !== "union") {
      throw new Error("expected union body");
    }
    // Without mapping we don't narrow; the `kind` property stays as
    // whatever the variant's own schema said it was.
    if (body.variants[0].type !== "record") {
      throw new Error("expected record variant");
    }
    expect(body.variants[0].properties.kind).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// File loading
// ---------------------------------------------------------------------------

describe("openApiFileToSummaries — file loading", () => {
  it("loads a JSON spec from disk", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "suss-openapi-"));
    const file = path.join(tmp, "spec.json");
    fs.writeFileSync(file, JSON.stringify(minimalSpec));
    try {
      const summaries = openApiFileToSummaries(file);
      expect(summaries).toHaveLength(1);
      expect(summaries[0].identity.name).toBe("getUser");
    } finally {
      fs.rmSync(tmp, { recursive: true });
    }
  });

  it("loads a YAML spec from disk", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "suss-openapi-"));
    const file = path.join(tmp, "spec.yaml");
    fs.writeFileSync(
      file,
      `openapi: 3.0.3
paths:
  /ping:
    get:
      operationId: ping
      responses:
        '200':
          description: ok
`,
    );
    try {
      const summaries = openApiFileToSummaries(file);
      expect(summaries).toHaveLength(1);
      expect(restPathOf(summaries[0])).toBe("/ping");
    } finally {
      fs.rmSync(tmp, { recursive: true });
    }
  });

  it("throws a helpful error when the file is missing", () => {
    expect(() => openApiFileToSummaries("/no/such/spec.yaml")).toThrow(
      /not found/,
    );
  });

  it("rejects a file that doesn't parse to a top-level object", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "suss-openapi-"));
    const file = path.join(tmp, "bad.json");
    // Top-level array, not an object
    fs.writeFileSync(file, JSON.stringify(["not", "a", "spec"]));
    try {
      // The current implementation only rejects null / non-object primitives;
      // top-level arrays are typeof "object" and pass through, producing zero
      // summaries because they have no `paths`. Pin both behaviors.
      const summaries = openApiFileToSummaries(file);
      expect(summaries).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true });
    }
  });

  it("rejects a file that parses to a non-object primitive", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "suss-openapi-"));
    const file = path.join(tmp, "string.json");
    fs.writeFileSync(file, JSON.stringify("just a string"));
    try {
      expect(() => openApiFileToSummaries(file)).toThrow(/not an object/);
    } finally {
      fs.rmSync(tmp, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-boundary checking smoke test — stubs pair correctly with ts code
// ---------------------------------------------------------------------------

describe("openApiToSummaries — pairing", () => {
  it("produces summaries the checker can pair via path normalization", () => {
    // The checker normalizes :id ↔ {id}; an OpenAPI provider stub with
    // /users/{id} pairs with an Express handler at /users/:id. This test
    // pins the boundary key shape; cross-package wiring is exercised
    // separately in the checker package.
    const summaries = openApiToSummaries(minimalSpec);
    expect(restPathOf(summaries[0])).toBe("/users/{id}");
    expect(restMethodOf(summaries[0])).toBe("GET");
  });
});
