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
  Transition,
  TypeShape,
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
