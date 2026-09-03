import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { graphqlRubyTestPack } from "./__fixtures__/graphqlRubyPattern.js";
import {
  controllerActionsPattern,
  railsTestPack,
} from "./__fixtures__/railsControllerPattern.js";
import { createFileCache, discoverUnits } from "./discovery.js";
import { parseRuby } from "./parser.js";

import type { ControllerActions, RubyPack } from "./pack.js";

/** For tests that never resolve a `mutation:` or `resolver:` reference, and so never read a file. */
function inMemoryCache(files: Record<string, string> = {}) {
  return createFileCache(
    (source) => parseRuby(source).then((tree) => tree.rootNode),
    (absPath) => files[absPath] ?? null,
  );
}

/** The disk-reading cache the extraction entry point builds, needed by the one-hop tests below. */
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

  it("discovers fields on a class whose base is two hops away through a project base", async () => {
    const units = await discover(
      "class Types::AdminObject < Types::BaseObject\n" +
        "end\n" +
        "class Types::UserType < Types::AdminObject\n" +
        "  field :id, ID, null: false\n" +
        "end\n",
    );
    expect(units.map((u) => u.identity.name)).toEqual(["User.id"]);
  });

  it("discovers fields on an interface module that mixes in the interface base", async () => {
    const units = await discover(
      "module Types::UserInterface\n" +
        "  include Types::BaseInterface\n" +
        "  field :id, ID, null: false\n" +
        "end\n",
      graphqlRubyTestPack({
        baseClassNames: ["Types::BaseObject", "Types::BaseInterface"],
      }),
    );
    expect(units.map((u) => u.identity.name)).toEqual(["UserInterface.id"]);
  });

  it("does not discover a module that mixes in nothing configured", async () => {
    const units = await discover(
      "module Types::Helpers\n" + "  field :id, ID, null: false\n" + "end\n",
    );
    expect(units).toEqual([]);
  });

  it("does not discover a configured base class as a type of its own", async () => {
    const units = await discover(
      "class Types::BaseObject < GraphQL::Schema::Object\n" +
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

  it("abstains on a field name this module can't read, binding it to nothing and saying why", async () => {
    const units = await discover(
      "class Types::CampaignType < Types::BaseObject\n" +
        "  field name_variable, ID, null: false\n" +
        "end\n",
    );
    expect(units.map((u) => u.identity.name)).toEqual([
      "Campaign.name_variable",
    ]);
    expect(units[0]?.boundaryBinding).toBeNull();
    expect(units[0]?.readings?.[0]).toMatchObject({
      kind: "unreadable",
      reason:
        "This field is named by name_variable, which is worked out when the class body runs, so the name the schema exposes it under was not read here",
    });
  });

  it("keeps the last declaration when a field is redefined in the same class body, per graphql-ruby's own last-wins registration", async () => {
    const units = await discover(
      "class Types::CampaignType < Types::BaseObject\n" +
        "  field :name, String, null: true\n" +
        "  field :name, Types::CampaignType, null: true\n" +
        "end\n",
    );
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
    expect(campaignId?.graphqlDeclaredContract?.returnType).toEqual({
      type: "ref",
      name: "ID",
    });
  });

  it("keeps the enclosing module on the nesting chain when the referencing class's own name is compound", async () => {
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
    expect(campaignName?.graphqlDeclaredContract?.returnType).toEqual({
      type: "ref",
      name: "String",
    });
  });
});

describe("discoverUnits: where in a class body the declaration is written", () => {
  const inside = (body: string) =>
    `class Types::CampaignType < Types::BaseObject\n${body}\nend\n`;

  const cases: ReadonlyArray<readonly [string, string]> = [
    ["an if", "  if enabled?\n    field :name, String, null: true\n  end"],
    [
      "the else of an if",
      "  if enabled?\n    nil\n  else\n    field :name, String, null: true\n  end",
    ],
    [
      "an unless",
      "  unless hidden?\n    field :name, String, null: true\n  end",
    ],
    [
      "a case",
      '  case tier\n  when "paid"\n    field :name, String, null: true\n  end',
    ],
    [
      "a do block",
      "  [String].each do |type|\n    field :name, type, null: true\n  end",
    ],
    [
      "a brace block",
      "  [String].each { |type| field :name, type, null: true }",
    ],
    [
      "a begin",
      "  begin\n    field :name, String, null: true\n  rescue StandardError\n    nil\n  end",
    ],
    [
      "a while",
      "  done = false\n  while done == false\n    field :name, String, null: true\n    done = true\n  end",
    ],
    ["a modifier if", "  field :name, String, null: true if enabled?"],
    [
      "a class_eval block",
      "  class_eval do\n    field :name, String, null: true\n  end",
    ],
  ];

  for (const [where, body] of cases) {
    it(`reads a field written inside ${where}`, async () => {
      const units = await discover(inside(body));
      expect(units.map((u) => u.identity.name)).toEqual(["Campaign.name"]);
    });
  }

  it("reads a class written inside an if", async () => {
    const units = await discover(
      "if ENV['SCHEMA'] != 'minimal'\n" +
        "  class Types::CampaignType < Types::BaseObject\n" +
        "    field :name, String, null: true\n" +
        "  end\n" +
        "end\n",
    );
    expect(units.map((u) => u.identity.name)).toEqual(["Campaign.name"]);
  });

  it("reads the method behind a field when the def is written inside an if", async () => {
    const units = await discover(
      inside(
        "  field :name, String, null: true\n" +
          "  if enabled?\n" +
          "    def name\n" +
          "      object.title\n" +
          "    end\n" +
          "  end",
      ),
    );
    expect(units[0]?.bodyContent).toBe("statements");
  });

  it("leaves an argument declared in a field's own block off the class", async () => {
    const units = await discover(
      inside(
        "  field :name, String, null: true do\n" +
          "    argument :locale, String, required: false\n" +
          "  end",
      ),
    );
    expect(units.map((u) => u.identity.name)).toEqual(["Campaign.name"]);
  });

  it("does not read a field declared in a def, which runs when the method is called", async () => {
    const units = await discover(
      inside("  def wire\n    field :name, String, null: true\n  end"),
    );
    expect(units).toEqual([]);
  });
});

// `resolveConstantFile` checks the filesystem before a lookup ever reaches the
// file cache, so these tests have to write their classes to disk.
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

  it("crosses a project base defined in its own file", async () => {
    write(
      "types/admin_object.rb",
      "class Types::AdminObject < Types::BaseObject\nend\n",
    );
    const tree = await parseRuby(
      "class Types::UserType < Types::AdminObject\n" +
        "  field :id, ID, null: false\n" +
        "end\n",
    );
    const units = await discoverUnits(tree.rootNode, {
      packs: [pack],
      filePath: "types/user_type.rb",
      cache: diskCache(),
    });
    expect(units.map((u) => u.identity.name)).toEqual(["User.id"]);
  });

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

  it("wraps a RelayClassicMutation's arguments into one input argument on the wire", async () => {
    write(
      "mutations/base_mutation.rb",
      "class Mutations::BaseMutation < GraphQL::Schema::RelayClassicMutation\nend\n",
    );
    write(
      "mutations/campaign_update.rb",
      "class Mutations::CampaignUpdate < Mutations::BaseMutation\n" +
        "  argument :campaign_id, ID, required: true\n" +
        "  argument :name, String, required: false\n" +
        "  field :campaign, Types::CampaignType, null: true\n" +
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

    expect(units[0]?.graphqlDeclaredContract?.args).toEqual([
      {
        name: "input",
        required: true,
        type: {
          type: "record",
          properties: {
            campaignId: { type: "text" },
            name: {
              type: "union",
              variants: [{ type: "text" }, { type: "undefined" }],
            },
            clientMutationId: {
              type: "union",
              variants: [{ type: "text" }, { type: "undefined" }],
            },
          },
        },
      },
    ]);
    // The library unwraps input before calling resolve, so the
    // method's parameters follow the declared arguments.
    expect(units[0]?.parameters).toEqual([
      { name: "campaignId", position: 0, role: "args", typeText: "ID" },
      { name: "name", position: 1, role: "args", typeText: "String" },
    ]);
  });

  it("keeps a plain Mutation's arguments flat on the wire", async () => {
    write(
      "mutations/base_mutation.rb",
      "class Mutations::BaseMutation < GraphQL::Schema::Mutation\nend\n",
    );
    write(
      "mutations/campaign_update.rb",
      "class Mutations::CampaignUpdate < Mutations::BaseMutation\n" +
        "  argument :campaign_id, ID, required: true\n" +
        "  field :campaign, Types::CampaignType, null: true\n" +
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

    expect(units[0]?.graphqlDeclaredContract?.args).toEqual([
      { name: "campaignId", type: { type: "text" }, required: true },
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

describe("discoverUnits: controller actions", () => {
  const ROUTED_PACK: RubyPack = railsTestPack({
    routeFor: (controllerQualifiedName, actionName) =>
      controllerQualifiedName === "OrdersController" && actionName === "index"
        ? { method: "get", path: "/orders" }
        : null,
  });

  async function discoverActions(source: string, pack: RubyPack = ROUTED_PACK) {
    const tree = await parseRuby(source);
    return discoverUnits(tree.rootNode, {
      packs: [pack],
      filePath: "controllers/orders_controller.rb",
      cache: inMemoryCache(),
    });
  }

  it("discovers every instance method a controller defines directly, routed or not", async () => {
    const units = await discoverActions(
      "class OrdersController < ApplicationController\n" +
        "  def index\n" +
        "  end\n" +
        "  def preview\n" +
        "  end\n" +
        "end\n",
    );
    expect(units.map((u) => u.identity.name)).toEqual(["index", "preview"]);
  });

  it("binds a routed action with restBinding, at what routeFor gives it", async () => {
    const units = await discoverActions(
      "class OrdersController < ApplicationController\n" +
        "  def index\n" +
        "  end\n" +
        "end\n",
    );
    expect(units[0]?.boundaryBinding).toEqual({
      transport: "http",
      semantics: { name: "rest", method: "GET", path: "/orders" },
      recognition: "rails",
    });
  });

  it("discovers an action routeFor answers null for, with no boundary binding", async () => {
    const units = await discoverActions(
      "class OrdersController < ApplicationController\n" +
        "  def preview\n" +
        "  end\n" +
        "end\n",
    );
    expect(units[0]?.boundaryBinding).toBeNull();
  });

  it("does not discover methods on a class whose ancestry does not reach a configured base", async () => {
    const units = await discoverActions(
      "class OrdersController < SomeOtherBase\n" +
        "  def index\n" +
        "  end\n" +
        "end\n",
    );
    expect(units).toEqual([]);
  });

  it("discovers a controller reaching a configured base through a project base two hops away", async () => {
    const units = await discoverActions(
      "class ApiController < ApplicationController\n" +
        "end\n" +
        "class OrdersController < ApiController\n" +
        "  def index\n" +
        "  end\n" +
        "end\n",
    );
    expect(units.map((u) => u.identity.name)).toEqual(["index"]);
  });

  it("gives every discovered action the pattern's default status code", async () => {
    const units = await discoverActions(
      "class OrdersController < ApplicationController\n" +
        "  def preview\n" +
        "  end\n" +
        "end\n",
      railsTestPack({ defaultStatusCode: 204 }),
    );
    expect(units[0]?.branches[0]?.terminal.statusCode).toEqual({
      type: "literal",
      value: 204,
    });
  });

  it("exports each action under [controllerQualifiedName, actionName]", async () => {
    const units = await discoverActions(
      "class OrdersController < ApplicationController\n" +
        "  def index\n" +
        "  end\n" +
        "end\n",
    );
    expect(units[0]?.identity.exportPath).toEqual([
      "OrdersController",
      "index",
    ]);
  });

  it("seeds the reach walk with every discovered action's own method", async () => {
    const tree = await parseRuby(
      "class OrdersController < ApplicationController\n" +
        "  def index\n" +
        "    OrderService.new.list_orders\n" +
        "  end\n" +
        "end\n",
    );
    const seeded: string[] = [];
    await discoverUnits(tree.rootNode, {
      packs: [ROUTED_PACK],
      filePath: "controllers/orders_controller.rb",
      absoluteFile: "/app/controllers/orders_controller.rb",
      cache: inMemoryCache(),
      onReachSeed: (raw) => seeded.push(raw.identity.name),
    });
    expect(seeded).toEqual(["index"]);
  });

  it("reports drainRoutingGaps' messages once, on the batch of units for the controller it fires on", async () => {
    let calls = 0;
    const pattern: ControllerActions = controllerActionsPattern({
      drainRoutingGaps: () => {
        calls += 1;
        return calls === 1 ? ["config/routes.rb also declares mount"] : [];
      },
    });
    const pack: RubyPack = {
      name: "rails",
      protocol: "http",
      discovery: [pattern],
    };

    const first = await discoverActions(
      "class OrdersController < ApplicationController\n" +
        "  def index\n" +
        "  end\n" +
        "end\n",
      pack,
    );
    const reasons = first
      .flatMap((u) => u.readings ?? [])
      .filter(
        (r): r is Extract<typeof r, { kind: "unreadable" }> =>
          r.kind === "unreadable",
      )
      .map((r) => r.reason);
    expect(reasons.some((reason) => reason.includes("mount"))).toBe(true);

    const second = await discoverActions(
      "class ItemsController < ApplicationController\n" +
        "  def index\n" +
        "  end\n" +
        "end\n",
      pack,
    );
    expect(second.some((u) => (u.readings ?? []).length > 0)).toBe(false);
  });
});
