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

/** The summary `@suss/client-apollo` produces for a `useQuery` or `useMutation` call, built by hand here rather than extracted. */
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

/** What the extractor says about a summary whose body nobody read at all. */
const NO_BODY =
  "This unit is a declaration with no body behind it, so nothing about what it does was read here";

/** What it says instead once a body is attached and nothing in it matched a shape the pack looks for. */
const BODY_READ_NOTHING_MATCHED =
  "Nothing this unit's body does matches a shape this pack looks for, so what it does is not described here";

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
        "Organizer.displayName",
        "Organizer.phone",
        "Organizer.status",
        "Query.campaign",
        "Mutation.campaignUpdate",
      ].sort(),
    );
  });

  it("every discovered field is low-confidence: v0 traces nothing through a body", async () => {
    const { summaries } = await extractFixture();
    expect(summaries.every((s) => s.confidence.level === "low")).toBe(true);
  });

  it("every discovered field is transitionless: v0 does no path-engine work", async () => {
    const { summaries } = await extractFixture();
    expect(summaries.every((s) => s.transitions.length === 0)).toBe(true);
  });

  describe("the method behind a field", () => {
    async function gapsFor(name: string): Promise<string[]> {
      const { summaries } = await extractFixture();
      const summary = summaries.find((s) => s.identity.name === name);
      expect(summary, name).toBeDefined();
      return (summary?.gaps ?? []).map((gap) => gap.description);
    }

    it("attaches the method written below the field in the same class", async () => {
      expect(await gapsFor("Organizer.displayName")).toEqual([
        BODY_READ_NOTHING_MATCHED,
      ]);
    });

    it("attaches the method a concern the class includes defines", async () => {
      expect(await gapsFor("Organizer.phone")).toEqual([
        BODY_READ_NOTHING_MATCHED,
      ]);
    });

    it("attaches the resolve method of the class a mutation-wired field points at", async () => {
      expect(await gapsFor("Mutation.campaignUpdate")).toEqual([
        BODY_READ_NOTHING_MATCHED,
      ]);
    });

    it("attaches the resolve method of the class a resolver-wired field points at", async () => {
      expect(await gapsFor("Query.campaign")).toEqual([
        BODY_READ_NOTHING_MATCHED,
      ]);
    });

    it("still says a field with no method behind it has no body, and says nothing else", async () => {
      expect(await gapsFor("Campaign.id")).toEqual([NO_BODY]);
      expect(await gapsFor("Organizer.email")).toEqual([NO_BODY]);
    });
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

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.kind).toBe("boundaryFieldUnknown");
    expect(result.findings[0]?.description).toContain("doesNotExist");
  });
});
