import { describe, expect, it } from "vitest";

import { checkGraphqlContractAgreement } from "./graphqlContractAgreement.js";

import type { BehavioralSummary, TypeShape } from "@suss/behavioral-ir";

function resolverSummary(
  name: string,
  source: string,
  contract: {
    returnType: TypeShape;
    args?: Array<{ name: string; type: TypeShape; required: boolean }>;
    provenance?: "derived" | "independent";
  } | null,
): BehavioralSummary {
  return {
    kind: "resolver",
    location: { file: source, range: { start: 0, end: 0 }, exportName: null },
    identity: {
      name,
      exportPath: null,
      boundaryBinding: {
        transport: "http-graphql",
        recognition: "test",
        semantics: {
          name: "graphql-resolver",
          typeName: "Query",
          fieldName: name.replace("Query.", ""),
        },
      },
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "derived", level: "high" },
    metadata:
      contract === null
        ? {}
        : {
            graphql: {
              declaredContract: {
                returnType: contract.returnType,
                args: contract.args ?? [],
                provenance: contract.provenance ?? "independent",
              },
            },
          },
  };
}

describe("checkGraphqlContractAgreement", () => {
  it("returns no findings when only one source declares a contract", () => {
    const a = resolverSummary("Query.user", "schema-a.graphql", {
      returnType: { type: "ref", name: "User" },
    });
    expect(checkGraphqlContractAgreement([a])).toEqual([]);
  });

  it("returns no findings when two sources agree on return type + args", () => {
    const a = resolverSummary("Query.user", "schema-a.graphql", {
      returnType: { type: "ref", name: "User" },
      args: [{ name: "id", type: { type: "text" }, required: true }],
    });
    const b = resolverSummary("Query.user", "schema-b.graphql", {
      returnType: { type: "ref", name: "User" },
      args: [{ name: "id", type: { type: "text" }, required: true }],
    });
    expect(checkGraphqlContractAgreement([a, b])).toEqual([]);
  });

  it("flags incompatible return types", () => {
    const a = resolverSummary("Query.user", "schema-a.graphql", {
      returnType: { type: "text" },
    });
    const b = resolverSummary("Query.user", "schema-b.graphql", {
      returnType: { type: "number" },
    });
    const findings = checkGraphqlContractAgreement([a, b]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("contractDisagreement");
    expect(findings[0]?.description).toMatch(/return type/i);
  });

  it("flags incompatible argument types at a shared name", () => {
    const a = resolverSummary("Query.user", "schema-a.graphql", {
      returnType: { type: "ref", name: "User" },
      args: [{ name: "id", type: { type: "text" }, required: true }],
    });
    const b = resolverSummary("Query.user", "schema-b.graphql", {
      returnType: { type: "ref", name: "User" },
      args: [{ name: "id", type: { type: "number" }, required: true }],
    });
    const findings = checkGraphqlContractAgreement([a, b]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.description).toMatch(/argument "id"/);
  });

  it("flags an argument present on one independent source but missing from another", () => {
    const a = resolverSummary("Query.user", "schema-a.graphql", {
      returnType: { type: "ref", name: "User" },
      args: [{ name: "id", type: { type: "text" }, required: true }],
      provenance: "independent",
    });
    const b = resolverSummary("Query.user", "schema-b.graphql", {
      returnType: { type: "ref", name: "User" },
      args: [],
      provenance: "independent",
    });
    const findings = checkGraphqlContractAgreement([a, b]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.description).toMatch(/declares argument "id"/);
  });

  it("does NOT flag arg-set differences when either source is derived", () => {
    const a = resolverSummary("Query.user", "schema-a.graphql", {
      returnType: { type: "ref", name: "User" },
      args: [{ name: "id", type: { type: "text" }, required: true }],
      provenance: "derived",
    });
    const b = resolverSummary("Query.user", "schema-b.graphql", {
      returnType: { type: "ref", name: "User" },
      args: [],
      provenance: "derived",
    });
    expect(checkGraphqlContractAgreement([a, b])).toEqual([]);
  });

  it("ignores summaries without a graphql-resolver binding", () => {
    const restSummary: BehavioralSummary = {
      kind: "handler",
      location: {
        file: "rest.ts",
        range: { start: 0, end: 0 },
        exportName: null,
      },
      identity: {
        name: "GET /users",
        exportPath: null,
        boundaryBinding: {
          transport: "http",
          recognition: "express",
          semantics: { name: "rest", method: "GET", path: "/users" },
        },
      },
      inputs: [],
      transitions: [],
      gaps: [],
      confidence: { source: "inferred_static", level: "high" },
      metadata: {},
    };
    expect(checkGraphqlContractAgreement([restSummary])).toEqual([]);
  });

  it("ignores graphql-resolver summaries without a declared contract", () => {
    const a = resolverSummary("Query.user", "schema-a.graphql", null);
    const b = resolverSummary("Query.user", "schema-b.graphql", {
      returnType: { type: "ref", name: "User" },
    });
    expect(checkGraphqlContractAgreement([a, b])).toEqual([]);
  });
});
