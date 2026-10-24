import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  GRAPHQL_OUTPUT_OPTIONS,
  graphqlRubyTestPack,
} from "./__fixtures__/graphqlRubyPattern.js";
import { contractShapeOf, outputShape } from "./graphqlOutput.js";
import { extractRubyProject, findRubyFiles } from "./project.js";

import type { BehavioralSummary, TypeShape } from "@suss/behavioral-ir";
import type { GraphqlObjectFields } from "./pack.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-ruby-graphql-output-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(relPath: string, lines: readonly string[]): void {
  const full = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, `${lines.join("\n")}\n`);
}

const BASE_OBJECT = [
  "class Types::BaseObject < GraphQL::Schema::Object",
  "end",
];

const CAMPAIGN_TYPE = [
  "class Types::CampaignType < Types::BaseObject",
  '  graphql_name "Campaign"',
  "",
  "  field :id, ID, null: false",
  "  field :name, String",
  "  field :tags, [String, null: true], null: false",
  "end",
];

async function extract(
  options: Partial<GraphqlObjectFields> = GRAPHQL_OUTPUT_OPTIONS,
): Promise<BehavioralSummary[]> {
  write("app/graphql/types/base_object.rb", BASE_OBJECT);
  write("app/graphql/types/campaign_type.rb", CAMPAIGN_TYPE);
  const { summaries } = await extractRubyProject({
    files: findRubyFiles(tmpDir),
    packs: [
      graphqlRubyTestPack({
        root: path.join(tmpDir, "app", "graphql"),
        ...options,
      }),
    ],
    workspaceRoot: tmpDir,
  });
  return summaries;
}

function named(
  summaries: readonly BehavioralSummary[],
  name: string,
): BehavioralSummary {
  const found = summaries.find((s) => s.identity.name === name);
  expect(found, name).toBeDefined();
  return found as BehavioralSummary;
}

function outputs(summary: BehavioralSummary): unknown[] {
  return summary.transitions.map((t) => t.output);
}

const orNull = (shape: TypeShape): TypeShape => ({
  type: "union",
  variants: [shape, { type: "null" }],
});

const CAMPAIGN_REF: TypeShape = {
  type: "ref",
  name: "Campaign",
  def: "Campaign",
  from: "app/graphql/types/campaign_type.rb",
};

const CAMPAIGN_RECORD: TypeShape = {
  type: "record",
  properties: {
    id: { type: "text" },
    name: orNull({ type: "text" }),
    tags: { type: "array", items: orNull({ type: "text" }) },
  },
};

describe("the type a field declares", () => {
  it("records the object type under its own GraphQL name, its fields, and null where the schema allows it", async () => {
    write("app/graphql/types/query_type.rb", [
      "class Types::QueryType < Types::BaseObject",
      "  field :campaign, Types::CampaignType",
      "",
      "  def campaign",
      "    Campaign.first",
      "  end",
      "end",
    ]);
    const summaries = await extract();
    const campaign = named(summaries, "Query.campaign");
    expect(outputs(campaign)).toEqual([
      { type: "return", value: orNull(CAMPAIGN_REF) },
    ]);
    expect(campaign.definitions).toEqual({ Campaign: CAMPAIGN_RECORD });
    expect(campaign.metadata?.graphql).toMatchObject({
      declaredContract: { returnType: { type: "ref", name: "Campaign" } },
    });
    // The type's own fields are keyed by the name it sets for itself.
    expect(named(summaries, "Campaign.id").identity.boundaryBinding).toEqual(
      expect.objectContaining({
        semantics: expect.objectContaining({ typeName: "Campaign" }),
      }),
    );
  });

  it("reads a type given under the type keyword, and a list's own null keyword", async () => {
    write("app/graphql/types/query_type.rb", [
      "class Types::QueryType < Types::BaseObject",
      "  field :campaigns, type: [Types::CampaignType, null: true], null: false",
      "",
      "  def campaigns",
      "    Campaign.all",
      "  end",
      "end",
    ]);
    const campaigns = named(await extract(), "Query.campaigns");
    expect(outputs(campaigns)).toEqual([
      {
        type: "return",
        value: { type: "array", items: orNull(CAMPAIGN_REF) },
      },
    ]);
  });

  it("records a connection as the type the library generates, with its edges and page info", async () => {
    write("app/graphql/types/query_type.rb", [
      "class Types::QueryType < Types::BaseObject",
      "  field :campaigns, Types::CampaignType.connection_type, null: false",
      "",
      "  def campaigns",
      "    Campaign.all",
      "  end",
      "end",
    ]);
    const campaigns = named(await extract(), "Query.campaigns");
    expect(outputs(campaigns)).toEqual([
      {
        type: "return",
        value: {
          type: "ref",
          name: "CampaignConnection",
          def: "CampaignConnection",
        },
      },
    ]);
    expect(campaigns.definitions).toEqual({
      Campaign: CAMPAIGN_RECORD,
      CampaignConnection: {
        type: "record",
        properties: {
          nodes: orNull({ type: "array", items: orNull(CAMPAIGN_REF) }),
          edges: orNull({
            type: "array",
            items: orNull({
              type: "ref",
              name: "CampaignEdge",
              def: "CampaignEdge",
            }),
          }),
          pageInfo: { type: "ref", name: "PageInfo", def: "PageInfo" },
        },
      },
      CampaignEdge: {
        type: "record",
        properties: { cursor: { type: "text" }, node: orNull(CAMPAIGN_REF) },
      },
      PageInfo: {
        type: "record",
        properties: { hasNextPage: { type: "boolean" } },
      },
    });
    expect(campaigns.metadata?.graphql).toMatchObject({
      declaredContract: {
        returnType: { type: "ref", name: "CampaignConnection" },
      },
    });
  });

  it("puts the type a wrapper takes as an argument in place, and the library's own when the call passes none", async () => {
    write("app/graphql/types/stats_type.rb", [
      "class Types::StatsType < Types::BaseObject",
      "  field :total, Integer, null: false",
      "end",
    ]);
    write("app/graphql/types/query_type.rb", [
      "class Types::QueryType < Types::BaseObject",
      "  field :campaigns, Types::CampaignType.collection_type(metadata_type: Types::StatsType), null: false",
      "  field :others, Types::CampaignType.collection_type, null: false",
      "",
      "  def campaigns",
      "    Campaign.all",
      "  end",
      "",
      "  def others",
      "    Campaign.all",
      "  end",
      "end",
    ]);
    const summaries = await extract();
    expect(
      named(summaries, "Query.campaigns").definitions?.CampaignCollection,
    ).toEqual({
      type: "record",
      properties: {
        collection: { type: "array", items: CAMPAIGN_REF },
        metadata: {
          type: "ref",
          name: "Stats",
          def: "Stats",
          from: "app/graphql/types/stats_type.rb",
        },
      },
    });
    const others = named(summaries, "Query.others").definitions;
    expect(others?.CampaignCollection).toMatchObject({
      properties: {
        metadata: {
          type: "ref",
          name: "CollectionMetadata",
          def: "CollectionMetadata",
        },
      },
    });
    expect(others?.CollectionMetadata).toEqual({
      type: "record",
      properties: { totalCount: { type: "number" } },
    });
  });

  it("lets a field's own type and null keyword win over the class it is wired to", async () => {
    write("app/graphql/resolvers/campaign_resolver.rb", [
      "class Resolvers::CampaignResolver < GraphQL::Schema::Resolver",
      "  type [Types::CampaignType], null: true",
      "  null false",
      "",
      "  def resolve",
      "    Campaign.first",
      "  end",
      "end",
    ]);
    write("app/graphql/types/query_type.rb", [
      "class Types::QueryType < Types::BaseObject",
      "  field :listed, resolver: Resolvers::CampaignResolver",
      "  field :one, Types::CampaignType, null: true, resolver: Resolvers::CampaignResolver",
      "end",
    ]);
    const summaries = await extract();
    // `null false` comes after the type call's `null: true`, and wins.
    expect(outputs(named(summaries, "Query.listed"))).toEqual([
      { type: "return", value: { type: "array", items: CAMPAIGN_REF } },
    ]);
    expect(outputs(named(summaries, "Query.one"))).toEqual([
      { type: "return", value: orNull(CAMPAIGN_REF) },
    ]);
  });

  it("says nothing about null when the pack does not say how a field reads it", async () => {
    write("app/graphql/types/query_type.rb", [
      "class Types::QueryType < Types::BaseObject",
      "  field :count, Integer",
      "",
      "  def count",
      "    Campaign.count",
      "  end",
      "end",
    ]);
    const count = named(await extract({}), "Query.count");
    expect(outputs(count)).toEqual([
      { type: "return", value: { type: "number" } },
    ]);
  });
});

describe("what each path returns", () => {
  it("records null on a path that returns nil, and what a hash the code builds holds", async () => {
    write("app/graphql/mutations/archive.rb", [
      "class Mutations::Archive < GraphQL::Schema::Mutation",
      "  field :campaign, Types::CampaignType",
      "  field :errors, [String], null: false",
      "",
      "  def resolve",
      "    return nil if Window.closed?",
      "",
      "    { campaign: Campaign.first, errors: [] }",
      "  end",
      "end",
    ]);
    write("app/graphql/types/mutation_type.rb", [
      "class Types::MutationType < Types::BaseObject",
      "  field :archive, mutation: Mutations::Archive",
      "end",
    ]);
    const archive = named(await extract(), "Mutation.archive");
    expect(outputs(archive)).toEqual([
      { type: "return", value: { type: "null" } },
      {
        type: "return",
        value: {
          type: "record",
          properties: {
            // A nested object type is named and not read, so its ref has no definition.
            campaign: orNull({ type: "ref", name: "Campaign" }),
            errors: { type: "array", items: { type: "text" } },
          },
        },
      },
    ]);
  });

  it("reads what an endless method returns", async () => {
    write("app/graphql/types/query_type.rb", [
      "class Types::QueryType < Types::BaseObject",
      "  field :total, Integer, null: false",
      "",
      "  def total = 3",
      "end",
    ]);
    expect(outputs(named(await extract(), "Query.total"))).toEqual([
      { type: "return", value: { type: "literal", value: 3 } },
    ]);
  });
});

describe("errors a resolver raises or returns", () => {
  it("names the class a helper builds for a raise, and the error a ternary arm or a rescue clause returns", async () => {
    write("app/graphql/types/query_type.rb", [
      "class Types::QueryType < Types::BaseObject",
      "  field :campaign, Types::CampaignType",
      "  field :first_campaign, Types::CampaignType",
      "",
      "  def campaign",
      "    raise unauthorized unless context[:user]",
      "",
      "    found = Campaign.find_by(id: 1)",
      "    found.nil? ? missing : found",
      "  end",
      "",
      "  def first_campaign",
      "    Campaign.first!",
      "  rescue ActiveRecord::RecordNotFound",
      "    missing",
      "  end",
      "",
      "  private",
      "",
      "  def unauthorized",
      '    GraphQL::ExecutionError.new("unauthorized")',
      "  end",
      "",
      "  def missing",
      '    GraphQL::ExecutionError.new("missing")',
      "  end",
      "end",
    ]);
    const summaries = await extract();
    const thrown = (name: string) =>
      named(summaries, name).transitions.map((t) =>
        t.output.type === "throw" ? t.output.exceptionType : t.output.type,
      );
    expect(thrown("Query.campaign")).toEqual([
      "GraphQL::ExecutionError",
      "GraphQL::ExecutionError",
      "return",
    ]);
    expect(thrown("Query.firstCampaign")).toEqual([
      "GraphQL::ExecutionError",
      "return",
    ]);
  });

  it("drops the return of a path whose every value is an error", async () => {
    write("app/graphql/types/query_type.rb", [
      "class Types::QueryType < Types::BaseObject",
      "  field :closed, Types::CampaignType",
      "",
      "  def closed",
      '    GraphQL::ExecutionError.new("closed")',
      "  end",
      "end",
    ]);
    const closed = named(await extract(), "Query.closed");
    expect(outputs(closed)).toEqual([
      {
        type: "throw",
        exceptionType: "GraphQL::ExecutionError",
        message: null,
      },
    ]);
  });

  it("turns a bare false from authorized? into the library's error, and one from ready? into null", async () => {
    write("app/graphql/mutations/approve.rb", [
      "class Mutations::Approve < GraphQL::Schema::Mutation",
      "  type Types::CampaignType",
      "",
      "  def ready?(**args)",
      "    return false if Window.closed?",
      "",
      "    true",
      "  end",
      "",
      "  def authorized?(**args)",
      "    context[:user].present?",
      "    false",
      "  end",
      "",
      "  def resolve",
      "    Campaign.first",
      "  end",
      "end",
    ]);
    write("app/graphql/types/mutation_type.rb", [
      "class Types::MutationType < Types::BaseObject",
      "  field :approve, mutation: Mutations::Approve",
      "end",
    ]);
    const summaries = await extract();
    const hookOutputs = (name: string) =>
      summaries
        .find((s) => s.kind === "middleware" && s.identity.name === name)
        ?.transitions.map((t) => t.output);
    expect(hookOutputs("ready?")).toEqual([
      { type: "return", value: { type: "null" } },
      { type: "delegate", to: "unknown" },
    ]);
    expect(hookOutputs("authorized?")).toEqual([
      {
        type: "throw",
        exceptionType: "GraphQL::UnauthorizedFieldError",
        message: null,
      },
    ]);
  });
});

describe("outputShape", () => {
  it("keeps what the code returns when nothing is declared, and says nothing when the code says nothing", () => {
    expect(outputShape({ type: "literal", value: true }, null)).toEqual({
      type: "literal",
      value: true,
    });
    expect(outputShape({ type: "unknown" }, null)).toBeNull();
  });

  it("fills a record's unread keys from the record a ref's definition gives, and leaves keys the type does not declare", () => {
    const declared = {
      shape: orNull({ type: "ref", name: "Payload", def: "Payload" }),
      definitions: {
        Payload: {
          type: "record",
          properties: { ok: { type: "boolean" } },
        } as TypeShape,
      },
    };
    expect(
      outputShape(
        {
          type: "record",
          properties: { ok: { type: "unknown" }, extra: { type: "unknown" } },
        },
        declared,
      ),
    ).toEqual({
      type: "record",
      properties: { ok: { type: "boolean" }, extra: { type: "unknown" } },
    });
    // A ref with no definition gives the record nothing to fill in.
    expect(
      outputShape(
        { type: "record", properties: { ok: { type: "unknown" } } },
        { shape: { type: "ref", name: "Elsewhere" }, definitions: {} },
      ),
    ).toEqual({ type: "record", properties: { ok: { type: "unknown" } } });
  });

  it("fills each variant of a union the code returns", () => {
    expect(
      outputShape(
        { type: "union", variants: [{ type: "null" }, { type: "unknown" }] },
        { shape: { type: "text" }, definitions: {} },
      ),
    ).toEqual({
      type: "union",
      variants: [{ type: "null" }, { type: "text" }],
    });
  });
});

describe("contractShapeOf", () => {
  it("leaves out null and a ref's definition key, the way a contract read from SDL writes the type", () => {
    expect(
      contractShapeOf({
        type: "array",
        items: orNull(CAMPAIGN_REF),
      }),
    ).toEqual({ type: "array", items: { type: "ref", name: "Campaign" } });
    expect(
      contractShapeOf({
        type: "union",
        variants: [{ type: "text" }, { type: "number" }, { type: "null" }],
      }),
    ).toEqual({
      type: "union",
      variants: [{ type: "text" }, { type: "number" }],
    });
  });
});
