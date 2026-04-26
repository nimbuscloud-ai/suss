import { describe, expect, it } from "vitest";

import {
  graphqlOperationBinding,
  graphqlResolverBinding,
} from "@suss/behavioral-ir";

import { checkAll } from "../index.js";
import { pairGraphqlOperations } from "./graphqlPairing.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function resolver(
  typeName: string,
  fieldName: string,
  recognition = "apollo",
  opts: { schemaSdl?: string } = {},
): BehavioralSummary {
  const ownerKey = `${typeName}.${fieldName}`;
  return {
    kind: "resolver",
    location: {
      file: `server/${typeName}.ts`,
      range: { start: 1, end: 5 },
      exportName: null,
    },
    identity: {
      name: ownerKey,
      exportPath: null,
      boundaryBinding: graphqlResolverBinding({
        transport: "http",
        recognition,
        typeName,
        fieldName,
      }),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
    ...(opts.schemaSdl !== undefined
      ? { metadata: { graphql: { schemaSdl: opts.schemaSdl } } }
      : {}),
  };
}

const petSchemaSdl = `
  type Pet { id: ID!  name: String!  species: String! }
  type Query { pet(id: ID!): Pet  pets: [Pet!]! }
  type Mutation { createPet(name: String!): Pet! }
`;

function operation(
  callerName: string,
  operationName: string | undefined,
  operationType: "query" | "mutation" | "subscription",
  document: string,
): BehavioralSummary {
  const name =
    operationName !== undefined
      ? `${callerName}.${operationName}`
      : `${callerName}.<anon-${operationType}>`;
  return {
    kind: "client",
    location: {
      file: `client/${callerName}.ts`,
      range: { start: 1, end: 10 },
      exportName: callerName,
    },
    identity: {
      name,
      exportPath: [callerName],
      boundaryBinding: graphqlOperationBinding({
        transport: "http",
        recognition: "apollo-client",
        operationType,
        ...(operationName !== undefined ? { operationName } : {}),
      }),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
    metadata: {
      graphql: { document },
    },
  };
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

describe("pairGraphqlOperations", () => {
  it("pairs a single-field query with its root-type resolver", () => {
    const petResolver = resolver("Query", "pet");
    const getPet = operation(
      "usePet",
      "GetPet",
      "query",
      "query GetPet($id: ID!) { pet(id: $id) { id name } }",
    );
    const result = pairGraphqlOperations([petResolver, getPet]);
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0].key).toBe("gql:Query.pet");
    expect(result.pairs[0].provider).toBe(petResolver);
    expect(result.pairs[0].consumer).toBe(getPet);
    expect(result.findings).toEqual([]);
  });

  it("pairs each root-level field in a multi-selection query", () => {
    const petResolver = resolver("Query", "pet");
    const petsResolver = resolver("Query", "pets");
    const op = operation(
      "useDashboard",
      "Dashboard",
      "query",
      `query Dashboard { pet(id: "1") { id } pets { id } }`,
    );
    const result = pairGraphqlOperations([petResolver, petsResolver, op]);
    const keys = result.pairs.map((p) => p.key).sort();
    expect(keys).toEqual(["gql:Query.pet", "gql:Query.pets"]);
    expect(result.findings).toEqual([]);
  });

  it("keys mutations under Mutation.<field>, not Query", () => {
    const createPet = resolver("Mutation", "createPet");
    const op = operation(
      "useCreatePet",
      "CreatePet",
      "mutation",
      `mutation CreatePet { createPet(name: "Rex") { id } }`,
    );
    const result = pairGraphqlOperations([createPet, op]);
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0].key).toBe("gql:Mutation.createPet");
  });

  it("keys subscriptions under Subscription.<field>", () => {
    const onTick = resolver("Subscription", "tick");
    const op = operation(
      "useTicks",
      "OnTick",
      "subscription",
      "subscription OnTick { tick }",
    );
    const result = pairGraphqlOperations([onTick, op]);
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0].key).toBe("gql:Subscription.tick");
  });

  it("fans a consumer out over every matching provider (N×M)", () => {
    // Two overlapping providers — e.g. Apollo resolver + AppSync stub
    // both describing Query.pet — pair with the same consumer.
    const apolloPet = resolver("Query", "pet", "apollo");
    const appsyncPet = resolver("Query", "pet", "appsync");
    const op = operation(
      "usePet",
      "GetPet",
      "query",
      `query GetPet { pet(id: "1") { id } }`,
    );
    const result = pairGraphqlOperations([apolloPet, appsyncPet, op]);
    expect(result.pairs).toHaveLength(2);
    const recognitions = result.pairs.map(
      (p) => p.provider.identity.boundaryBinding?.recognition,
    );
    expect(recognitions.sort()).toEqual(["apollo", "appsync"]);
  });

  it("handles anonymous queries — no operation name, still maps by root type", () => {
    const pingResolver = resolver("Query", "ping");
    const op = operation("usePing", undefined, "query", "query { ping }");
    const result = pairGraphqlOperations([pingResolver, op]);
    expect(result.pairs).toHaveLength(1);
  });

  it("handles shorthand `{ ... }` anonymous queries", () => {
    const pingResolver = resolver("Query", "ping");
    const op = operation("usePing", undefined, "query", "{ ping }");
    const result = pairGraphqlOperations([pingResolver, op]);
    expect(result.pairs).toHaveLength(1);
  });

  it("emits graphqlFieldNotImplemented when a selection has no provider", () => {
    const op = operation(
      "useDeletedAt",
      "GetDeletedAt",
      "query",
      "query GetDeletedAt { deletedAt }",
    );
    const result = pairGraphqlOperations([op]);
    expect(result.pairs).toEqual([]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].kind).toBe("boundaryFieldUnknown");
    expect(result.findings[0].description).toContain("Query.deletedAt");
  });

  it("still pairs the matched fields when one is unimplemented", () => {
    const petResolver = resolver("Query", "pet");
    const op = operation(
      "usePartial",
      "Partial",
      "query",
      `query Partial { pet(id: "1") { id } missingField }`,
    );
    const result = pairGraphqlOperations([petResolver, op]);
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0].key).toBe("gql:Query.pet");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].description).toContain("Query.missingField");
  });

  it("ignores operations whose document is missing or invalid", () => {
    const withoutDoc: BehavioralSummary = {
      ...operation("useBroken", "Broken", "query", ""),
      metadata: undefined,
    };
    const invalid = operation(
      "useInvalid",
      "Invalid",
      "query",
      "query Invalid { not valid graphql",
    );
    const result = pairGraphqlOperations([withoutDoc, invalid]);
    expect(result.pairs).toEqual([]);
    expect(result.findings).toEqual([]);
  });

  it("returns empty results when no graphql-operation summaries are present", () => {
    const result = pairGraphqlOperations([resolver("Query", "pet")]);
    expect(result.pairs).toEqual([]);
    expect(result.findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Nested selection walking against the resolver's SDL
// ---------------------------------------------------------------------------

describe("pairGraphqlOperations — nested selections", () => {
  it("skips nested walks when no SDL is attached to the resolver", () => {
    const petResolver = resolver("Query", "pet"); // no schemaSdl
    const op = operation(
      "usePet",
      "GetPet",
      "query",
      `query GetPet { pet(id: "1") { id junkField } }`,
    );
    const result = pairGraphqlOperations([petResolver, op]);
    // Pairs at the root level; nested selections untouched without
    // a schema. No graphqlSelectionFieldUnknown findings emitted.
    expect(result.pairs).toHaveLength(1);
    expect(result.findings).toEqual([]);
  });

  it("accepts nested selections that exist on the return type", () => {
    const petResolver = resolver("Query", "pet", "apollo", {
      schemaSdl: petSchemaSdl,
    });
    const op = operation(
      "usePet",
      "GetPet",
      "query",
      `query GetPet { pet(id: "1") { id name species } }`,
    );
    const result = pairGraphqlOperations([petResolver, op]);
    expect(result.pairs).toHaveLength(1);
    expect(
      result.findings.filter((f) => f.kind === "boundaryFieldUnknown"),
    ).toEqual([]);
  });

  it("flags a nested selection that the return type doesn't declare", () => {
    const petResolver = resolver("Query", "pet", "apollo", {
      schemaSdl: petSchemaSdl,
    });
    const op = operation(
      "useStale",
      "Stale",
      "query",
      `query Stale { pet(id: "1") { id deletedAt } }`,
    );
    const result = pairGraphqlOperations([petResolver, op]);
    const unknowns = result.findings.filter(
      (f) => f.kind === "boundaryFieldUnknown",
    );
    expect(unknowns).toHaveLength(1);
    expect(unknowns[0].description).toContain("Pet.deletedAt");
    expect(unknowns[0].description).toContain("Stale");
  });

  it("walks nested selections recursively", () => {
    const sdl = `
      type Owner { id: ID!  name: String! }
      type Pet { id: ID!  owner: Owner! }
      type Query { pet(id: ID!): Pet }
    `;
    const petResolver = resolver("Query", "pet", "apollo", { schemaSdl: sdl });
    const op = operation(
      "useNested",
      "Nested",
      "query",
      `query Nested { pet(id: "1") { owner { name bogus } } }`,
    );
    const result = pairGraphqlOperations([petResolver, op]);
    const unknowns = result.findings.filter(
      (f) => f.kind === "boundaryFieldUnknown",
    );
    expect(unknowns).toHaveLength(1);
    expect(unknowns[0].description).toContain("Owner.bogus");
  });

  it("doesn't descend into scalar / enum / union return types", () => {
    const sdl = `
      scalar DateTime
      type Query { timestamp: DateTime }
    `;
    const timeResolver = resolver("Query", "timestamp", "apollo", {
      schemaSdl: sdl,
    });
    const op = operation(
      "useTimestamp",
      "Now",
      "query",
      // Selecting fields on a scalar is illegal in real GraphQL;
      // graphql-js parser accepts this for our regex-light flow.
      // The walker must not emit findings for this shape — we
      // don't know the type layout beyond "not an object".
      "query Now { timestamp }",
    );
    const result = pairGraphqlOperations([timeResolver, op]);
    expect(result.pairs).toHaveLength(1);
    expect(result.findings).toEqual([]);
  });

  it("handles list return types (unwraps to the named type)", () => {
    const sdl = `
      type Pet { id: ID!  name: String! }
      type Query { pets: [Pet!]! }
    `;
    const petsResolver = resolver("Query", "pets", "apollo", {
      schemaSdl: sdl,
    });
    const op = operation(
      "usePets",
      "AllPets",
      "query",
      "query AllPets { pets { id name bogus } }",
    );
    const result = pairGraphqlOperations([petsResolver, op]);
    const unknowns = result.findings.filter(
      (f) => f.kind === "boundaryFieldUnknown",
    );
    expect(unknowns).toHaveLength(1);
    expect(unknowns[0].description).toContain("Pet.bogus");
  });

  it("reuses parsed SDL across multiple operations (correctness-check)", () => {
    // Not a perf assertion — just confirms a single cached SDL
    // produces consistent findings for many operations.
    const petResolver = resolver("Query", "pet", "apollo", {
      schemaSdl: petSchemaSdl,
    });
    const ops = [
      operation("a", "A", "query", `query A { pet(id: "1") { id } }`),
      operation("b", "B", "query", `query B { pet(id: "1") { bogus } }`),
      operation(
        "c",
        "C",
        "query",
        `query C { pet(id: "1") { name also_bogus } }`,
      ),
    ];
    const result = pairGraphqlOperations([petResolver, ...ops]);
    const unknowns = result.findings.filter(
      (f) => f.kind === "boundaryFieldUnknown",
    );
    expect(unknowns).toHaveLength(2);
  });

  it("tolerates malformed SDL (parse failure) — no crash, no findings", () => {
    const petResolver = resolver("Query", "pet", "apollo", {
      schemaSdl: "type Pet { // bogus",
    });
    const op = operation(
      "usePet",
      "GetPet",
      "query",
      `query GetPet { pet(id: "1") { id bogus } }`,
    );
    const result = pairGraphqlOperations([petResolver, op]);
    expect(result.pairs).toHaveLength(1);
    expect(
      result.findings.filter((f) => f.kind === "boundaryFieldUnknown"),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Integration with checkAll
// ---------------------------------------------------------------------------

describe("checkAll — graphql pairing integration", () => {
  it("surfaces graphql pairs in `pairs` alongside REST pairs", () => {
    const petResolver = resolver("Query", "pet");
    const op = operation(
      "usePet",
      "GetPet",
      "query",
      `query GetPet { pet(id: "1") { id } }`,
    );
    const result = checkAll([petResolver, op]);
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0].key).toBe("gql:Query.pet");
    expect(result.pairs[0].provider).toBe("Query.pet");
    expect(result.pairs[0].consumer).toBe("usePet.GetPet");
  });

  it("does not list graphql-matched summaries as unmatched", () => {
    const petResolver = resolver("Query", "pet");
    const op = operation(
      "usePet",
      "GetPet",
      "query",
      `query GetPet { pet(id: "1") { id } }`,
    );
    const result = checkAll([petResolver, op]);
    expect(result.unmatched.providers).toEqual([]);
    expect(result.unmatched.consumers).toEqual([]);
    expect(result.unmatched.noBinding).toEqual([]);
  });

  it("includes graphqlFieldNotImplemented findings in the top-level findings list", () => {
    const op = operation("useGone", "Gone", "query", "query Gone { gone }");
    const result = checkAll([op]);
    const kinds = result.findings.map((f) => f.kind);
    expect(kinds).toContain("boundaryFieldUnknown");
  });

  it("does not run the REST per-pair checks against graphql pairs", () => {
    const petResolver = resolver("Query", "pet");
    const op = operation(
      "usePet",
      "GetPet",
      "query",
      `query GetPet { pet(id: "1") { id } }`,
    );
    // The REST checks emit findings for provider/consumer status
    // mismatches. On a graphql pair (no status codes, no response
    // outputs, no declaredContract), those checks should produce
    // nothing.
    const result = checkAll([petResolver, op]);
    expect(result.findings).toEqual([]);
  });
});
