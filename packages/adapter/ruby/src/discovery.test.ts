import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { graphqlRubyTestPack } from "./__fixtures__/graphqlRubyPattern.js";
import { createFileCache, discoverUnits } from "./discovery.js";
import { parseRuby } from "./parser.js";

import type { RubyPack } from "./pack.js";

/** A file cache backed by an in-memory source map, for the tests below that never resolve a `mutation:` / `resolver:` reference and so never touch it. */
function inMemoryCache(files: Record<string, string> = {}) {
  return createFileCache(
    (source) => parseRuby(source).then((tree) => tree.rootNode),
    (absPath) => files[absPath] ?? null,
  );
}

/** The cache `project.ts` builds in production: reads files off disk. Used by the one-hop tests below, since `resolveConstantFile` checks the filesystem before the cache is ever consulted. */
function diskCache() {
  return createFileCache(
    (source) => parseRuby(source).then((tree) => tree.rootNode),
    (absPath) =>
      fs.existsSync(absPath) ? fs.readFileSync(absPath, "utf8") : null,
  );
}

const OBJECT_PACK: RubyPack = graphqlRubyTestPack();

async function discover(source: string, pack: RubyPack = OBJECT_PACK) {
  const tree = await parseRuby(source);
  return discoverUnits(tree.rootNode, {
    packs: [pack],
    filePath: "types/campaign_type.rb",
    cache: inMemoryCache(),
  });
}

describe("discoverUnits: object type fields", () => {
  it("discovers each literal field on a class matching a configured base class", async () => {
    const units = await discover(
      "class Types::CampaignType < Types::BaseObject\n" +
        "  field :id, ID, null: false\n" +
        "  field :name, String, null: true\n" +
        "end\n",
    );
    expect(units.map((u) => u.identity.name)).toEqual([
      "Campaign.id",
      "Campaign.name",
    ]);
    expect(units[0]?.boundaryBinding).toEqual({
      transport: "http-graphql",
      semantics: {
        name: "graphql-resolver",
        typeName: "Campaign",
        fieldName: "id",
      },
      recognition: "graphql-ruby",
    });
    expect(units[0]?.graphqlDeclaredContract).toEqual({
      returnType: { type: "text" },
      args: [],
      provenance: "derived",
      framework: "graphql-ruby",
    });
  });

  it("camelizes a snake_case field symbol into its GraphQL field name", async () => {
    const units = await discover(
      "class Types::MutationType < Types::BaseObject\n" +
        "  field :campaign_update, String, null: true\n" +
        "end\n",
    );
    expect(units[0]?.identity.name).toBe("Mutation.campaignUpdate");
  });

  it("does not discover fields on a class whose superclass isn't configured", async () => {
    const units = await discover(
      "class Types::CampaignType < SomeOtherBase\n" +
        "  field :id, ID, null: false\n" +
        "end\n",
    );
    expect(units).toEqual([]);
  });

  it("is transitionless: no branches", async () => {
    const units = await discover(
      "class Types::CampaignType < Types::BaseObject\n" +
        "  field :id, ID, null: false\n" +
        "end\n",
    );
    expect(units[0]?.branches).toEqual([]);
  });

  it("will not call a body absent while a base class it could not read might define one", async () => {
    const units = await discover(
      "class Types::CampaignType < Types::BaseObject\n" +
        "  field :id, ID, null: false\n" +
        "end\n",
    );
    expect(units[0]?.bodyContent).toBeUndefined();
    expect(units[0]?.readings?.[0]).toMatchObject({
      kind: "unreadable",
      reason:
        "This field could be answered by a method inherited from Types::BaseObject, which this run did not read, so whether one exists was not settled here",
    });
  });

  it("abstains on a computed type expression: the field is discovered, but with no declared contract", async () => {
    const units = await discover(
      "class Types::OrganizerType < Types::BaseObject\n" +
        "  field :status, status_label_for(:organizer), null: true\n" +
        "end\n",
    );
    expect(units.map((u) => u.identity.name)).toEqual(["Organizer.status"]);
    expect(units[0]?.graphqlDeclaredContract).toBeUndefined();
  });

  it("skips a field name this module can't read (not a plain symbol literal)", async () => {
    const units = await discover(
      "class Types::CampaignType < Types::BaseObject\n" +
        "  field name_variable, ID, null: false\n" +
        "end\n",
    );
    expect(units).toEqual([]);
  });

  it("keeps the last declaration when a field is redefined in the same class body, per graphql-ruby's own last-wins registration", async () => {
    const units = await discover(
      "class Types::CampaignType < Types::BaseObject\n" +
        "  field :name, String, null: true\n" +
        "  field :name, Types::CampaignType, null: true\n" +
        "end\n",
    );
    // One unit, not two conflicting ones for the same (typeName, fieldName).
    expect(units.map((u) => u.identity.name)).toEqual(["Campaign.name"]);
    expect(units[0]?.graphqlDeclaredContract?.returnType).toEqual({
      type: "ref",
      name: "Campaign",
    });
  });

  it("resolves a bare scalar name to the project's own class when nesting shadows it, not to the builtin", async () => {
    const units = await discover(
      "module Types\n" +
        "  class ID < Types::BaseObject\n" +
        "    field :value, String, null: true\n" +
        "  end\n" +
        "\n" +
        "  class CampaignType < Types::BaseObject\n" +
        "    field :id, ID, null: false\n" +
        "  end\n" +
        "end\n",
    );
    const campaignId = units.find((u) => u.identity.name === "Campaign.id");
    // Not { type: "text" }, the builtin ID scalar's shape: "Types::ID"
    // shadows the builtin at the "Types" nesting level, so this reads
    // as a ref to the project's own class instead.
    expect(campaignId?.graphqlDeclaredContract?.returnType).toEqual({
      type: "ref",
      name: "ID",
    });
  });

  it("resolves the same shadow when the referencing class's own name is compound, not just bare", async () => {
    // Module.nesting inside `Types::CampaignType`'s body still carries
    // "Api" even though the class's own name is written compound: Ruby
    // tracks lexical class/module keyword nesting regardless of the
    // name's shape. A "String" class module-scoped under Api has to
    // stay reachable from here the same way it would from a bare-named
    // CampaignType nested inside `module Api`.
    const units = await discover(
      "module Api\n" +
        "  class String < Types::BaseObject\n" +
        "    field :value, String, null: true\n" +
        "  end\n" +
        "\n" +
        "  class Types::CampaignType < Types::BaseObject\n" +
        "    field :name, String, null: true\n" +
        "  end\n" +
        "end\n",
    );
    const campaignName = units.find((u) => u.identity.name === "Campaign.name");
    // Not { type: "text" }, the builtin String scalar's shape:
    // "Api::String" shadows the builtin at the "Api" nesting level.
    expect(campaignName?.graphqlDeclaredContract?.returnType).toEqual({
      type: "ref",
      name: "String",
    });
  });
});

// resolveConstantFile checks the filesystem before a lookup ever
// reaches the file cache, so a one-hop test that expects a resolution
// to succeed needs a file written to disk, the way project.ts's own
// caller reads one.
describe("discoverUnits: mutation: / resolver: one-hop wiring", () => {
  let tmpDir: string;
  let graphqlRoot: string;
  let pack: RubyPack;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-ruby-onehop-"));
    graphqlRoot = path.join(tmpDir, "app", "graphql");
    pack = graphqlRubyTestPack({ root: graphqlRoot });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function write(relPath: string, content: string): void {
    const full = path.join(graphqlRoot, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  it("reads the referenced mutation class's own fields as the payload record", async () => {
    write(
      "mutations/campaign_update.rb",
      "class Mutations::CampaignUpdate < Mutations::BaseMutation\n" +
        "  argument :campaign_id, ID, required: true\n" +
        "  field :campaign, Types::CampaignType, null: true\n" +
        "  field :errors, [String], null: false\n" +
        "end\n",
    );
    const tree = await parseRuby(
      "class Types::MutationType < Types::BaseObject\n" +
        "  field :campaign_update, mutation: Mutations::CampaignUpdate\n" +
        "end\n",
    );
    const units = await discoverUnits(tree.rootNode, {
      packs: [pack],
      filePath: "types/mutation_type.rb",
      cache: diskCache(),
    });

    expect(units[0]?.identity.name).toBe("Mutation.campaignUpdate");
    expect(units[0]?.graphqlDeclaredContract).toEqual({
      returnType: {
        type: "record",
        properties: {
          campaign: { type: "ref", name: "Campaign" },
          errors: { type: "array", items: { type: "text" } },
        },
      },
      args: [{ name: "campaignId", type: { type: "text" }, required: true }],
      provenance: "derived",
      framework: "graphql-ruby",
    });
    expect(units[0]?.parameters).toEqual([
      { name: "campaignId", position: 0, role: "args", typeText: "ID" },
    ]);
  });

  it("reads the referenced resolver class's own type call as the return shape", async () => {
    write(
      "queries/campaign_query.rb",
      "class Queries::CampaignQuery < Queries::BaseQuery\n" +
        "  argument :campaign_id, ID, required: true\n" +
        "  type Types::CampaignType, null: true\n" +
        "end\n",
    );
    const tree = await parseRuby(
      "class Types::QueryType < Types::BaseObject\n" +
        "  field :campaign, resolver: Queries::CampaignQuery\n" +
        "end\n",
    );
    const units = await discoverUnits(tree.rootNode, {
      packs: [pack],
      filePath: "types/query_type.rb",
      cache: diskCache(),
    });

    expect(units[0]?.identity.name).toBe("Query.campaign");
    expect(units[0]?.graphqlDeclaredContract).toEqual({
      returnType: { type: "ref", name: "Campaign" },
      args: [{ name: "campaignId", type: { type: "text" }, required: true }],
      provenance: "derived",
      framework: "graphql-ruby",
    });
  });

  it("defaults a graphql-ruby argument to required when the keyword is absent", async () => {
    write(
      "queries/campaign_query.rb",
      "class Queries::CampaignQuery < Queries::BaseQuery\n" +
        "  argument :campaign_id, ID\n" +
        "  type Types::CampaignType, null: true\n" +
        "end\n",
    );
    const tree = await parseRuby(
      "class Types::QueryType < Types::BaseObject\n" +
        "  field :campaign, resolver: Queries::CampaignQuery\n" +
        "end\n",
    );
    const units = await discoverUnits(tree.rootNode, {
      packs: [pack],
      filePath: "types/query_type.rb",
      cache: diskCache(),
    });
    expect(units[0]?.graphqlDeclaredContract?.args).toEqual([
      { name: "campaignId", type: { type: "text" }, required: true },
    ]);
  });

  it("abstains when the referenced file doesn't exist at the conventional path", async () => {
    const tree = await parseRuby(
      "class Types::MutationType < Types::BaseObject\n" +
        "  field :campaign_update, mutation: Mutations::CampaignUpdate\n" +
        "end\n",
    );
    const units = await discoverUnits(tree.rootNode, {
      packs: [pack],
      filePath: "types/mutation_type.rb",
      cache: diskCache(),
    });
    expect(units[0]?.identity.name).toBe("Mutation.campaignUpdate");
    expect(units[0]?.graphqlDeclaredContract).toBeUndefined();
  });

  it("abstains when the referenced file exists but names no matching class", async () => {
    write("mutations/campaign_update.rb", "class SomethingElse\nend\n");
    const tree = await parseRuby(
      "class Types::MutationType < Types::BaseObject\n" +
        "  field :campaign_update, mutation: Mutations::CampaignUpdate\n" +
        "end\n",
    );
    const units = await discoverUnits(tree.rootNode, {
      packs: [pack],
      filePath: "types/mutation_type.rb",
      cache: diskCache(),
    });
    expect(units[0]?.graphqlDeclaredContract).toBeUndefined();
  });

  it("merges fields across a mutation class reopened in two separate blocks, rather than the second overwriting the first", async () => {
    write(
      "mutations/campaign_update.rb",
      "class Mutations::CampaignUpdate < Mutations::BaseMutation\n" +
        "  argument :campaign_id, ID, required: true\n" +
        "  field :campaign, Types::CampaignType, null: true\n" +
        "end\n" +
        "\n" +
        "# Reopened, ordinary Ruby: a later block still contributes fields\n" +
        "# to the same class rather than replacing the first block outright.\n" +
        "class Mutations::CampaignUpdate < Mutations::BaseMutation\n" +
        "  field :errors, [String], null: false\n" +
        "end\n",
    );
    const tree = await parseRuby(
      "class Types::MutationType < Types::BaseObject\n" +
        "  field :campaign_update, mutation: Mutations::CampaignUpdate\n" +
        "end\n",
    );
    const units = await discoverUnits(tree.rootNode, {
      packs: [pack],
      filePath: "types/mutation_type.rb",
      cache: diskCache(),
    });

    // Both blocks' fields show up in the payload; the second block
    // didn't discard what the first one declared.
    expect(units[0]?.graphqlDeclaredContract?.returnType).toEqual({
      type: "record",
      properties: {
        campaign: { type: "ref", name: "Campaign" },
        errors: { type: "array", items: { type: "text" } },
      },
    });
    expect(units[0]?.graphqlDeclaredContract?.args).toEqual([
      { name: "campaignId", type: { type: "text" }, required: true },
    ]);
  });
});

describe("discoverUnits: camelize", () => {
  it("camelizes a field's name by default, graphql-ruby's own default", async () => {
    const units = await discover(
      "class Types::MutationType < Types::BaseObject\n" +
        "  field :campaign_update, String, null: true\n" +
        "end\n",
    );
    expect(units[0]?.identity.name).toBe("Mutation.campaignUpdate");
  });

  it("leaves a field's name as written when that one call passes camelize: false", async () => {
    const units = await discover(
      "class Types::MutationType < Types::BaseObject\n" +
        "  field :campaign_update, String, null: true, camelize: false\n" +
        "end\n",
    );
    expect(units[0]?.identity.name).toBe("Mutation.campaign_update");
  });

  it("leaves every field's name as written when the pack's own camelize option is false", async () => {
    const pack: RubyPack = graphqlRubyTestPack({ camelizeDefault: false });
    const units = await discover(
      "class Types::MutationType < Types::BaseObject\n" +
        "  field :campaign_update, String, null: true\n" +
        "end\n",
      pack,
    );
    expect(units[0]?.identity.name).toBe("Mutation.campaign_update");
  });

  it("a field's own camelize: true overrides the pack's false default for that one name", async () => {
    const pack: RubyPack = graphqlRubyTestPack({ camelizeDefault: false });
    const units = await discover(
      "class Types::MutationType < Types::BaseObject\n" +
        "  field :campaign_update, String, null: true, camelize: true\n" +
        "end\n",
      pack,
    );
    expect(units[0]?.identity.name).toBe("Mutation.campaignUpdate");
  });

  it("also applies to an argument name read from a one-hop referenced class", async () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "suss-ruby-camelize-"),
    );
    const graphqlRoot = path.join(tmpDir, "app", "graphql");
    const mutationsDir = path.join(graphqlRoot, "mutations");
    fs.mkdirSync(mutationsDir, { recursive: true });
    fs.writeFileSync(
      path.join(mutationsDir, "campaign_update.rb"),
      "class Mutations::CampaignUpdate < Mutations::BaseMutation\n" +
        "  argument :campaign_id, ID, required: true, camelize: false\n" +
        "  field :campaign, Types::CampaignType, null: true\n" +
        "end\n",
    );
    const pack: RubyPack = graphqlRubyTestPack({ root: graphqlRoot });
    const tree = await parseRuby(
      "class Types::MutationType < Types::BaseObject\n" +
        "  field :campaign_update, mutation: Mutations::CampaignUpdate\n" +
        "end\n",
    );
    const units = await discoverUnits(tree.rootNode, {
      packs: [pack],
      filePath: "types/mutation_type.rb",
      cache: diskCache(),
    });

    expect(units[0]?.graphqlDeclaredContract?.args).toEqual([
      { name: "campaign_id", type: { type: "text" }, required: true },
    ]);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
