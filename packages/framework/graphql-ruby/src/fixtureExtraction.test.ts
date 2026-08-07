// fixtureExtraction.test.ts: the acceptance test for the Ruby
// adapter's v0 slice (docs/internal/proposals/language-adapters.md).
//
// Extracts over fixtures/ruby-graphql, a small invented fixture
// (sourced from nothing private) anchoring the shape the proposal
// names for Ruby: graphql-ruby's class DSL, literal fields on a couple
// of object types, one mutation-wired root field, one resolver-wired
// root field, and one field whose type is computed rather than
// literal, which abstains. `pairGraphqlOperations` (the checker's own
// graphql-operation-vs-graphql-resolver pass) pairs the extracted
// providers against hand-built apollo-client-shaped consumer
// summaries by (typeName, fieldName), which is the cross-language
// existence-pairing acceptance bar the proposal names: nothing here
// depends on the consumer summaries having come from Ruby, so the
// same pairing works once a TypeScript client extracts these documents.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { extractRubyProject, findRubyFiles } from "@suss/adapter-ruby";
import {
  graphqlOperationBinding,
  withGraphqlMetadata,
} from "@suss/behavioral-ir";
import { pairGraphqlOperations } from "@suss/checker";

import { graphqlRubyFramework } from "./index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);
const fixtureRoot = path.join(repoRoot, "fixtures", "ruby-graphql");
const graphqlRoot = path.join(fixtureRoot, "app", "graphql");

/**
 * The shape `@suss/client-apollo` produces for a `useQuery` /
 * `useMutation` call: a `client`-kind summary bound to a
 * `graphql-operation`, with the operation document carried as
 * `metadata.graphql.document` for the checker's pairing pass to parse.
 * Hand-built here rather than run through the TypeScript adapter,
 * matching the flask-restx acceptance test's own hand-built REST
 * consumers: the point is proving the pairing, not re-deriving what
 * the client pack already does.
 */
function operation(
  name: string,
  operationType: "query" | "mutation",
  document: string,
): BehavioralSummary {
  return {
    kind: "client",
    location: {
      file: "src/campaign.ts",
      range: { start: 0, end: 0 },
      exportName: null,
    },
    identity: {
      name,
      exportPath: null,
      boundaryBinding: graphqlOperationBinding({
        transport: "http",
        recognition: "apollo-client",
        operationType,
        operationName: name,
      }),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
    metadata: withGraphqlMetadata(undefined, { document }),
  };
}

async function extractFixture() {
  const files = findRubyFiles(graphqlRoot);
  return extractRubyProject({
    files,
    packs: [graphqlRubyFramework({ root: graphqlRoot })],
    workspaceRoot: repoRoot,
  });
}

describe("extraction over fixtures/ruby-graphql", () => {
  it("discovers every literal field, plus the mutation- and resolver-wired root fields", async () => {
    const { summaries } = await extractFixture();
    expect(summaries.map((s) => s.identity.name).sort()).toEqual(
      [
        "Campaign.id",
        "Campaign.name",
        "Campaign.budget",
        "Organizer.id",
        "Organizer.email",
        "Organizer.status",
        "Query.campaign",
        "Mutation.campaignUpdate",
      ].sort(),
    );
  });

  it("every discovered field is low-confidence: v0 reads no method body", async () => {
    const { summaries } = await extractFixture();
    expect(summaries.every((s) => s.confidence.level === "low")).toBe(true);
  });

  it("every discovered field is transitionless: v0 does no path-engine work", async () => {
    const { summaries } = await extractFixture();
    expect(summaries.every((s) => s.transitions.length === 0)).toBe(true);
  });

  it("resolves the resolver-wired field's return shape from the referenced class's own type call", async () => {
    const { summaries } = await extractFixture();
    const campaign = summaries.find(
      (s) => s.identity.name === "Query.campaign",
    );
    expect(campaign?.metadata?.graphql).toMatchObject({
      declaredContract: {
        returnType: { type: "ref", name: "Campaign" },
        args: [{ name: "campaignId", type: { type: "text" }, required: true }],
      },
    });
  });

  it("resolves the mutation-wired field's payload from the referenced class's own fields", async () => {
    const { summaries } = await extractFixture();
    const update = summaries.find(
      (s) => s.identity.name === "Mutation.campaignUpdate",
    );
    expect(update?.metadata?.graphql).toMatchObject({
      declaredContract: {
        returnType: {
          type: "record",
          properties: {
            campaign: { type: "ref", name: "Campaign" },
            errors: { type: "array", items: { type: "text" } },
          },
        },
      },
    });
  });

  it("abstains on the deliberately computed field: discovered by name, no declared contract", async () => {
    const { summaries } = await extractFixture();
    const status = summaries.find(
      (s) => s.identity.name === "Organizer.status",
    );
    expect(status).toBeDefined();
    expect(status?.metadata?.graphql).toBeUndefined();
  });

  it("pairs the extracted resolvers against apollo-client-shaped consumer operations by (typeName, fieldName)", async () => {
    const { summaries } = await extractFixture();
    const consumers = [
      operation(
        "GetCampaign",
        "query",
        "query GetCampaign { campaign { id name } }",
      ),
      operation(
        "UpdateCampaign",
        "mutation",
        "mutation UpdateCampaign { campaignUpdate { campaign { id } errors } }",
      ),
      operation(
        "GetNothing",
        "query",
        "query GetNothing { doesNotExist { id } }",
      ),
    ];

    const result = pairGraphqlOperations([...summaries, ...consumers]);

    const pairedKeys = result.pairs
      .map((p) => `${p.consumer.identity.name}<->${p.provider.identity.name}`)
      .sort();
    expect(pairedKeys).toEqual(
      [
        "GetCampaign<->Query.campaign",
        "UpdateCampaign<->Mutation.campaignUpdate",
      ].sort(),
    );

    // The consumer selecting a root field no provider implements
    // surfaces as a finding rather than a silent non-pair, proving
    // pairing does existence checking, beyond bucketing alone.
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.kind).toBe("boundaryFieldUnknown");
    expect(result.findings[0]?.description).toContain("doesNotExist");
  });
});
