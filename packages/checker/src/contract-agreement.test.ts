import { describe, expect, it } from "vitest";

import { restBinding } from "@suss/behavioral-ir";

import { checkContractAgreement } from "./contract-agreement.js";

import type { BehavioralSummary, TypeShape } from "@suss/behavioral-ir";

function providerWithContract(
  name: string,
  file: string,
  framework: string,
  contract: {
    provenance: "derived" | "independent";
    responses: Array<{ statusCode: number; body?: TypeShape | null }>;
  },
): BehavioralSummary {
  return {
    kind: "handler",
    location: { file, range: { start: 0, end: 0 }, exportName: null },
    identity: {
      name,
      exportPath: null,
      boundaryBinding: restBinding({
        transport: "http",
        method: "GET",
        path: "/pet/:id",
        recognition: framework,
      }),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "stub", level: "high" },
    metadata: {
      http: {
        declaredContract: {
          framework,
          provenance: contract.provenance,
          responses: contract.responses,
        },
      },
    },
  };
}

describe("checkContractAgreement", () => {
  it("emits nothing when only one source describes a boundary", () => {
    const only = providerWithContract(
      "pet-openapi",
      "petstore.yaml",
      "openapi",
      { provenance: "derived", responses: [{ statusCode: 200 }] },
    );
    expect(checkContractAgreement([only])).toEqual([]);
  });

  it("emits nothing when sources agree on the status set", () => {
    const a = providerWithContract("pet-openapi", "petstore.yaml", "openapi", {
      provenance: "derived",
      responses: [{ statusCode: 200 }, { statusCode: 404 }],
    });
    const b = providerWithContract("pet-cfn", "template.yaml", "apigateway", {
      provenance: "independent",
      responses: [{ statusCode: 200 }, { statusCode: 404 }],
    });
    expect(checkContractAgreement([a, b])).toEqual([]);
  });

  it("emits a contractDisagreement finding when a status is declared by one source only", () => {
    const openapi = providerWithContract(
      "pet-openapi",
      "petstore.yaml",
      "openapi",
      {
        provenance: "derived",
        responses: [{ statusCode: 200 }, { statusCode: 404 }],
      },
    );
    const cfn = providerWithContract("pet-cfn", "template.yaml", "apigateway", {
      provenance: "independent",
      responses: [
        { statusCode: 200 },
        { statusCode: 404 },
        { statusCode: 500 },
      ],
    });

    const findings = checkContractAgreement([openapi, cfn]);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("contractDisagreement");
    expect(findings[0].description).toMatch(
      /disagree on status 500.*declared by \[pet-cfn\].*not declared by \[pet-openapi\]/,
    );
    expect(findings[0].sources).toEqual([
      "petstore.yaml::pet-openapi",
      "template.yaml::pet-cfn",
    ]);
  });

  it("emits one finding per status that isn't unanimous (not per pair)", () => {
    const a = providerWithContract("a", "a.yaml", "openapi", {
      provenance: "derived",
      responses: [{ statusCode: 200 }, { statusCode: 400 }],
    });
    const b = providerWithContract("b", "b.yaml", "apigateway", {
      provenance: "independent",
      responses: [{ statusCode: 200 }, { statusCode: 404 }],
    });
    const c = providerWithContract("c", "c.yaml", "custom", {
      provenance: "independent",
      responses: [{ statusCode: 200 }, { statusCode: 500 }],
    });
    // 200 is unanimous; 400, 404, 500 each declared by exactly one
    // source → three disagreements, not six pairwise ones.
    const findings = checkContractAgreement([a, b, c]);
    expect(findings).toHaveLength(3);
    const statuses = findings
      .map((f) => {
        const m = /status (\d+)/.exec(f.description);
        return m?.[1];
      })
      .sort();
    expect(statuses).toEqual(["400", "404", "500"]);
  });

  it("emits body-shape disagreements at shared statuses", () => {
    const record = (props: Record<string, TypeShape>): TypeShape => ({
      type: "record",
      properties: props,
    });
    const a = providerWithContract("a", "a.yaml", "openapi", {
      provenance: "derived",
      responses: [{ statusCode: 200, body: record({ id: { type: "text" } }) }],
    });
    const b = providerWithContract("b", "b.yaml", "apigateway", {
      provenance: "independent",
      responses: [
        { statusCode: 200, body: record({ id: { type: "integer" } }) },
      ],
    });

    const findings = checkContractAgreement([a, b]);
    const bodyFindings = findings.filter((f) =>
      /body shape/.test(f.description),
    );
    expect(bodyFindings).toHaveLength(1);
    expect(bodyFindings[0].description).toMatch(
      /body shape for status 200.*incompatible/,
    );
  });

  it("ignores body-shape 'unknown' results — Layer 1 surfaces those already", () => {
    const ref = (name: string): TypeShape => ({ type: "ref", name });
    const a = providerWithContract("a", "a.yaml", "openapi", {
      provenance: "derived",
      responses: [{ statusCode: 200, body: ref("Pet") }],
    });
    const b = providerWithContract("b", "b.yaml", "apigateway", {
      provenance: "independent",
      responses: [{ statusCode: 200, body: ref("Animal") }],
    });
    const findings = checkContractAgreement([a, b]);
    const bodyFindings = findings.filter((f) =>
      /body shape/.test(f.description),
    );
    expect(bodyFindings).toEqual([]);
  });

  it("ignores summaries with no declaredContract", () => {
    const a = providerWithContract("a", "a.yaml", "openapi", {
      provenance: "derived",
      responses: [{ statusCode: 200 }],
    });
    const bNoContract: BehavioralSummary = {
      ...providerWithContract("b", "b.yaml", "other", {
        provenance: "independent",
        responses: [{ statusCode: 200 }],
      }),
      metadata: undefined,
    };
    // Only one source has a contract → no cross-source comparison
    expect(checkContractAgreement([a, bNoContract])).toEqual([]);
  });

  it("groups by normalized boundary key — `:id` and `{id}` treated as the same boundary", () => {
    const a = providerWithContract("a", "a.yaml", "openapi", {
      provenance: "derived",
      responses: [{ statusCode: 200 }],
    });
    const b: BehavioralSummary = providerWithContract(
      "b",
      "b.yaml",
      "apigateway",
      {
        provenance: "independent",
        responses: [{ statusCode: 200 }, { statusCode: 500 }],
      },
    );
    // Force the second source to use brace syntax.
    if (
      b.identity.boundaryBinding !== null &&
      b.identity.boundaryBinding.semantics.name === "rest"
    ) {
      b.identity.boundaryBinding = {
        ...b.identity.boundaryBinding,
        semantics: {
          ...b.identity.boundaryBinding.semantics,
          path: "/pet/{id}",
        },
      };
    }
    const findings = checkContractAgreement([a, b]);
    // Boundaries normalize to the same key → one disagreement on 500.
    expect(findings).toHaveLength(1);
    expect(findings[0].description).toMatch(/status 500/);
  });
});
