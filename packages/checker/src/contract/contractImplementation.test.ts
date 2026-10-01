import { describe, expect, it } from "vitest";

import {
  readHttpMetadata,
  restBinding,
  withHttpMetadata,
} from "@suss/behavioral-ir";

import { recordBody, response, transition } from "../__fixtures__/pairs.js";
import { checkContractImplementation } from "./contractImplementation.js";

import type {
  BehavioralSummary,
  Predicate,
  Transition,
  TypeShape,
  ValueRef,
} from "@suss/behavioral-ir";
import type { ComparedPair } from "../pairing/comparedPair.js";

function document(
  method: string,
  path: string,
  responses: Array<{ statusCode: number; body?: TypeShape }>,
): BehavioralSummary {
  return {
    kind: "handler",
    location: {
      file: "openapi:openapi.yaml",
      range: { start: 0, end: 0 },
      exportName: null,
    },
    identity: {
      name: `${method} ${path}`,
      exportPath: null,
      boundaryBinding: restBinding({
        transport: "http",
        method,
        path,
        recognition: "openapi",
      }),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "derived", level: "high" },
    metadata: {
      http: {
        declaredContract: {
          framework: "openapi",
          provenance: "derived",
          responses: responses.map((r) => ({
            statusCode: r.statusCode,
            body: r.body ?? null,
          })),
        },
      },
    },
  };
}

function handler(
  method: string,
  path: string,
  transitions: Transition[],
): BehavioralSummary {
  return {
    kind: "handler",
    location: {
      file: "src/app.ts",
      range: { start: 0, end: 0 },
      exportName: null,
    },
    identity: {
      name: `${method} ${path}`,
      exportPath: null,
      boundaryBinding: restBinding({
        transport: "http",
        method,
        path,
        recognition: "hono",
      }),
    },
    inputs: [],
    transitions,
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

function withOwnContract(
  summary: BehavioralSummary,
  statuses: number[],
): BehavioralSummary {
  return {
    ...summary,
    metadata: withHttpMetadata(summary.metadata, {
      ...readHttpMetadata(summary),
      declaredContract: {
        framework: "hono-openapi",
        provenance: "independent",
        responses: statuses.map((statusCode) => ({ statusCode })),
      },
    }),
  };
}

describe("checkContractImplementation", () => {
  it("reports a status the handler produces that the document leaves out as an error", () => {
    const findings = checkContractImplementation([
      document("POST", "/users", [{ statusCode: 201 }]),
      handler("POST", "/users", [
        transition("t-422", { output: response(422) }),
        transition("t-201", { output: response(201), isDefault: true }),
      ]),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("providerContractViolation");
    expect(findings[0].severity).toBe("error");
    expect(findings[0].description).toBe(
      "Handler produces status 422 which the openapi document does not declare",
    );
    expect(findings[0].provider.location.file).toBe("src/app.ts");
    expect(findings[0].consumer.location.file).toBe("openapi:openapi.yaml");
  });

  it("reports a declared status no path produces as a warning", () => {
    const findings = checkContractImplementation([
      document("GET", "/users/{id}", [
        { statusCode: 200 },
        { statusCode: 410 },
      ]),
      handler("GET", "/users/{id}", [
        transition("t-200", { output: response(200), isDefault: true }),
      ]),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].description).toBe(
      "The openapi document declares response 410, and no path in the handler produces it",
    );
  });

  it("leaves a declared status alone when the handler's own code declares it too", () => {
    const base = handler("GET", "/users/{id}", [
      transition("t-200", { output: response(200), isDefault: true }),
    ]);
    const findings = checkContractImplementation([
      document("GET", "/users/{id}", [
        { statusCode: 200 },
        { statusCode: 400 },
        { statusCode: 410 },
      ]),
      {
        ...base,
        metadata: withHttpMetadata(base.metadata, { declaredStatuses: [400] }),
      },
    ]);
    expect(findings.map((finding) => finding.description)).toEqual([
      "The openapi document declares response 410, and no path in the handler produces it",
    ]);
  });

  it("leaves a declared 5XX alone when the handler never produces it", () => {
    const findings = checkContractImplementation([
      document("GET", "/users", [{ statusCode: 200 }, { statusCode: 500 }]),
      handler("GET", "/users", [
        transition("t-200", { output: response(200), isDefault: true }),
      ]),
    ]);
    expect(findings).toEqual([]);
  });

  it("compares the body the handler returns with the declared schema", () => {
    const findings = checkContractImplementation([
      document("GET", "/users", [
        { statusCode: 200, body: recordBody("id", "name") },
      ]),
      handler("GET", "/users", [
        transition("t-200", {
          output: response(200, recordBody("id")),
          isDefault: true,
        }),
      ]),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("providerContractViolation");
    expect(findings[0].description).toContain("body on status 200");
  });

  it("says nothing when the handler matches the document", () => {
    const findings = checkContractImplementation([
      document("GET", "/users", [{ statusCode: 200 }, { statusCode: 404 }]),
      handler("GET", "/users", [
        transition("t-404", { output: response(404) }),
        transition("t-200", { output: response(200), isDefault: true }),
      ]),
    ]);
    expect(findings).toEqual([]);
  });

  it("skips a handler that has a contract of its own", () => {
    const findings = checkContractImplementation([
      document("POST", "/users", [{ statusCode: 201 }]),
      withOwnContract(
        handler("POST", "/users", [
          transition("t-422", { output: response(422) }),
          transition("t-201", { output: response(201), isDefault: true }),
        ]),
        [201, 422],
      ),
    ]);
    expect(findings).toEqual([]);
  });

  it("says nothing when the document and the handler share no route", () => {
    const findings = checkContractImplementation([
      document("GET", "/users", [{ statusCode: 200 }]),
      handler("GET", "/other", [
        transition("t-500", { output: response(500), isDefault: true }),
      ]),
    ]);
    expect(findings).toEqual([]);
  });

  it("records the handler and the document as a compared pair", () => {
    const compared: ComparedPair[] = [];
    checkContractImplementation(
      [
        document("GET", "/users", [{ statusCode: 200 }]),
        handler("GET", "/users", [
          transition("t-200", { output: response(200), isDefault: true }),
        ]),
      ],
      compared,
    );
    expect(compared).toHaveLength(1);
    expect(compared[0].key).toBe("GET /users");
    expect(compared[0].provider).toContain("src/app.ts");
    expect(compared[0].consumer).toContain("openapi:openapi.yaml");
  });
});

describe("checkContractImplementation, on a handler suss read in part", () => {
  /** `req.<path>` or `res.<path>`, as a chain of property reads. */
  const readOf = (input: "req" | "res", ...path: string[]): ValueRef =>
    path.reduce<ValueRef>(
      (from, property) => ({
        type: "derived",
        from,
        derivation: { type: "propertyAccess", property },
      }),
      { type: "input", inputRef: input, path: [] },
    );

  const truthy = (subject: ValueRef): Predicate => ({
    type: "truthinessCheck",
    subject,
    negated: false,
  });

  /** An Express-style handler: the request's sections and its two parameters. */
  function expressHandler(transitions: Transition[]): BehavioralSummary {
    const base = handler("DELETE", "/items", transitions);
    return {
      ...base,
      inputs: [
        {
          type: "parameter",
          name: "req",
          position: 0,
          role: "request",
          shape: null,
        },
        {
          type: "parameter",
          name: "res",
          position: 1,
          role: "response",
          shape: null,
        },
      ],
      metadata: {
        requestSpelling: {
          query: { path: ["request", "query"], saysWhichField: true },
          body: { path: ["request", "body"], saysWhichField: true },
        },
      },
    };
  }

  it("does not report a status reached only through state other code set", () => {
    const findings = checkContractImplementation([
      document("DELETE", "/items", [{ statusCode: 200 }]),
      expressHandler([
        // `if (!res.locals.payload) return res.status(204).end()`
        transition("t-204", {
          conditions: [truthy(readOf("res", "locals", "payload"))],
          output: response(204),
        }),
        // `if (req.sanitizedQuery.export)`, a field middleware set.
        transition("t-201", {
          conditions: [truthy(readOf("req", "sanitizedQuery", "export"))],
          output: response(201),
        }),
        transition("t-200", { output: response(200), isDefault: true }),
      ]),
    ]);
    expect(findings).toEqual([]);
  });

  it("still reports a status a request field decides", () => {
    const findings = checkContractImplementation([
      document("DELETE", "/items", [{ statusCode: 200 }]),
      expressHandler([
        transition("t-204", {
          conditions: [truthy(readOf("req", "query", "soft"))],
          output: response(204),
        }),
        transition("t-200", { output: response(200), isDefault: true }),
      ]),
    ]);
    expect(findings.map((f) => f.description)).toEqual([
      "Handler produces status 204 which the openapi document does not declare",
    ]);
  });

  it("does not report a status reached only through an opaque condition", () => {
    const findings = checkContractImplementation([
      document("GET", "/users", [{ statusCode: 200 }]),
      handler("GET", "/users", [
        transition("t-304", {
          conditions: [
            {
              type: "opaque",
              sourceText: "shouldCache",
              reason: "complexExpression",
            },
          ],
          output: response(304),
        }),
        transition("t-200", { output: response(200), isDefault: true }),
      ]),
    ]);
    expect(findings).toEqual([]);
  });

  it("still reports a status behind a local suss left unresolved", () => {
    // `if not cost_type.editable: raise HTTPException(301)` after a lookup.
    const findings = checkContractImplementation([
      document("PUT", "/cost-types/{id}", [{ statusCode: 200 }]),
      handler("PUT", "/cost-types/{id}", [
        transition("t-301", {
          conditions: [truthy({ type: "unresolved", sourceText: "cost_type" })],
          output: response(301),
        }),
        transition("t-200", { output: response(200), isDefault: true }),
      ]),
    ]);
    expect(findings.map((f) => f.description)).toEqual([
      "Handler produces status 301 which the openapi document does not declare",
    ]);
  });

  it("does not claim a declared failure is never sent when middleware runs first", () => {
    const routed = {
      ...handler("GET", "/users", [
        transition("t-200", { output: response(200), isDefault: true }),
      ]),
      metadata: {
        wrappers: { applied: [{ file: "src/auth.ts", name: "requireUser" }] },
      },
    };
    const findings = checkContractImplementation([
      document("GET", "/users", [{ statusCode: 200 }, { statusCode: 401 }]),
      routed,
    ]);
    expect(findings).toEqual([]);
  });

  it("still claims a declared failure is never sent past a dependency call it could not follow", () => {
    const callsTheDatabase = {
      ...handler("GET", "/users/{id}", [
        transition("t-200", { output: response(200), isDefault: true }),
      ]),
      gaps: [
        {
          type: "unfollowedCall" as const,
          conditions: [],
          consequence: "unknown" as const,
          description:
            "The call to db.findById lands on a declaration with no body",
          callee: "db.findById",
        },
      ],
    };
    const findings = checkContractImplementation([
      document("GET", "/users/{id}", [
        { statusCode: 200 },
        { statusCode: 429 },
      ]),
      callsTheDatabase,
    ]);
    expect(findings.map((f) => f.description)).toEqual([
      "The openapi document declares response 429, and no path in the handler produces it",
    ]);
  });

  it("does not claim a declared failure is never sent by a handler that throws", () => {
    const findings = checkContractImplementation([
      document("GET", "/users", [{ statusCode: 200 }, { statusCode: 404 }]),
      handler("GET", "/users", [
        transition("t-throw", {
          output: {
            type: "throw",
            exceptionType: "NotFoundError",
            message: null,
          },
        }),
        transition("t-200", { output: response(200), isDefault: true }),
      ]),
    ]);
    expect(findings).toEqual([]);
  });

  it("does not compare a body on a path reached through an unread condition", () => {
    const findings = checkContractImplementation([
      document("DELETE", "/items", [
        { statusCode: 200, body: recordBody("id") },
      ]),
      expressHandler([
        transition("t-export", {
          conditions: [truthy(readOf("req", "sanitizedQuery", "export"))],
          output: response(200, { type: "text" }),
        }),
        transition("t-200", {
          output: response(200, recordBody("id")),
          isDefault: true,
        }),
      ]),
    ]);
    expect(
      findings.filter((f) => f.kind === "providerContractViolation"),
    ).toEqual([]);
  });
});
