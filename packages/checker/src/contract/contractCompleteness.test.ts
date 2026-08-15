import { describe, expect, it } from "vitest";

import { restBinding } from "@suss/behavioral-ir";

import { checkContractCompleteness } from "./contractCompleteness.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

function stub(method: string, path: string): BehavioralSummary {
  return {
    kind: "handler",
    location: {
      file: "spec.json",
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
          responses: [{ statusCode: 200 }],
        },
      },
    },
  };
}

function implemented(method: string, path: string): BehavioralSummary {
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
    transitions: [],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

describe("checkContractCompleteness", () => {
  it("flags a declared operation nothing implements once the spec overlaps the code", () => {
    const findings = checkContractCompleteness([
      stub("POST", "/v1/provision"),
      stub("POST", "/v1/revive"),
      implemented("POST", "/v1/provision"),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("contractOperationUnimplemented");
    expect(findings[0].description).toContain("POST /v1/revive");
  });

  it("says nothing when the spec shares no boundary with the code", () => {
    const findings = checkContractCompleteness([
      stub("POST", "/v1/provision"),
      implemented("GET", "/other/route"),
    ]);
    expect(findings).toEqual([]);
  });

  it("says nothing when every declared operation is implemented", () => {
    const findings = checkContractCompleteness([
      stub("POST", "/v1/provision"),
      implemented("POST", "/v1/provision"),
      implemented("GET", "/healthz"),
    ]);
    expect(findings).toEqual([]);
  });
});
