import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { graphqlRubyTestPack } from "./__fixtures__/graphqlRubyPattern.js";
import { extractRubyProject, findRubyFiles } from "./project.js";

import type { RubyPack } from "./pack.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-ruby-project-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(relPath: string, content: string): string {
  const full = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

function graphqlRubyPack(root: string): RubyPack {
  return graphqlRubyTestPack({ root });
}

describe("findRubyFiles", () => {
  it("finds every .rb file under a root, skipping non-source directories", () => {
    write("app/graphql/types/campaign_type.rb", "");
    write("vendor/bundle/gems/some_gem.rb", "");
    write("app/graphql/types/README.md", "");
    const found = findRubyFiles(tmpDir).map((f) => path.relative(tmpDir, f));
    expect(found).toEqual(["app/graphql/types/campaign_type.rb"]);
  });
});

describe("extractRubyProject", () => {
  it("extracts summaries across files, resolving a one-hop reference to a file the caller never listed", async () => {
    const graphqlRoot = path.join(tmpDir, "app", "graphql");
    const campaignType = write(
      "app/graphql/types/campaign_type.rb",
      "class Types::CampaignType < Types::BaseObject\n  field :id, ID, null: false\nend\n",
    );
    const queryType = write(
      "app/graphql/types/query_type.rb",
      "class Types::QueryType < Types::BaseObject\n  field :campaign, resolver: Queries::CampaignQuery\nend\n",
    );
    write(
      "app/graphql/queries/campaign_query.rb",
      "class Queries::CampaignQuery < Queries::BaseQuery\n  type Types::CampaignType, null: true\nend\n",
    );

    const { summaries, facts } = await extractRubyProject({
      files: [campaignType, queryType],
      packs: [graphqlRubyPack(graphqlRoot)],
      workspaceRoot: tmpDir,
    });

    expect(summaries.map((s) => s.identity.name).sort()).toEqual(
      ["Campaign.id", "Query.campaign"].sort(),
    );
    expect(summaries.every((s) => s.confidence.level === "low")).toBe(true);

    const queryCampaign = summaries.find(
      (s) => s.identity.name === "Query.campaign",
    );
    expect(queryCampaign?.metadata?.graphql).toMatchObject({
      declaredContract: { returnType: { type: "ref", name: "Campaign" } },
    });

    expect(summaries.map((s) => s.location.file).sort()).toEqual(
      [
        "app/graphql/types/campaign_type.rb",
        "app/graphql/types/query_type.rb",
      ].sort(),
    );
    expect(facts.facts("entry")).toHaveLength(2);
  });

  it("produces no units for a file whose classes match no configured base class", async () => {
    const file = write(
      "app/graphql/my_app_schema.rb",
      "class MyAppSchema < GraphQL::Schema\n  query Types::QueryType\nend\n",
    );
    const { summaries } = await extractRubyProject({
      files: [file],
      packs: [graphqlRubyPack(path.join(tmpDir, "app", "graphql"))],
    });
    expect(summaries).toEqual([]);
  });

  it("keeps location.file absolute when no workspaceRoot is given", async () => {
    const file = write(
      "app/graphql/types/campaign_type.rb",
      "class Types::CampaignType < Types::BaseObject\n  field :id, ID, null: false\nend\n",
    );
    const { summaries } = await extractRubyProject({
      files: [file],
      packs: [graphqlRubyPack(path.join(tmpDir, "app", "graphql"))],
    });
    expect(summaries[0]?.location.file).toBe(file);
  });
});

/** The generated base classes a graphql-ruby project extends, so an ancestor walk over these fixtures ends where a generated project's does. */
function writeBaseClasses(): void {
  write(
    "app/graphql/types/base_object.rb",
    "class Types::BaseObject < GraphQL::Schema::Object\nend\n",
  );
  write(
    "app/graphql/queries/base_query.rb",
    "class Queries::BaseQuery < GraphQL::Schema::Resolver\nend\n",
  );
  write(
    "app/graphql/mutations/base_mutation.rb",
    "class Mutations::BaseMutation < GraphQL::Schema::Mutation\nend\n",
  );
}

/** Every sentence one field's summary leaves behind, so a test sees the ones it did not ask for. */
async function gapsOfOnlyField(file: string): Promise<string[]> {
  const { summaries } = await extractRubyProject({
    files: [file],
    packs: [graphqlRubyPack(path.join(tmpDir, "app", "graphql"))],
  });
  expect(summaries).toHaveLength(1);
  return (summaries[0]?.gaps ?? []).map((gap) => gap.description);
}

describe("the method behind a field", () => {
  beforeEach(writeBaseClasses);

  it("finds the method a concern the class includes defines", async () => {
    write(
      "app/graphql/concerns/displayable.rb",
      "module Concerns::Displayable\n  def display_name\n    object.name\n  end\nend\n",
    );
    const organizerType = write(
      "app/graphql/types/organizer_type.rb",
      "class Types::OrganizerType < Types::BaseObject\n  include Concerns::Displayable\n\n  field :display_name, String, null: false\nend\n",
    );
    expect(await gapsOfOnlyField(organizerType)).toEqual([
      "Nothing this unit's body does matches a shape this pack looks for, so what it does is not described here",
    ]);
  });

  it("finds the method a superclass defines", async () => {
    write(
      "app/graphql/types/base_person_type.rb",
      "class Types::BasePersonType < Types::BaseObject\n  def display_name\n    object.name\n  end\nend\n",
    );
    const organizerType = write(
      "app/graphql/types/organizer_type.rb",
      "class Types::OrganizerType < Types::BasePersonType\n  field :display_name, String, null: false\nend\n",
    );
    const { summaries } = await extractRubyProject({
      files: [organizerType],
      packs: [
        graphqlRubyTestPack({
          root: path.join(tmpDir, "app", "graphql"),
          baseClassNames: ["Types::BaseObject", "Types::BasePersonType"],
        }),
      ],
    });
    expect(summaries[0]?.gaps.map((gap) => gap.description)).toEqual([
      "Nothing this unit's body does matches a shape this pack looks for, so what it does is not described here",
    ]);
  });

  it("finds the resolve method a wired class inherits from its base class", async () => {
    write(
      "app/graphql/queries/base_query.rb",
      "class Queries::BaseQuery < GraphQL::Schema::Resolver\n  def resolve(**args)\n    scope.find_by(args)\n  end\nend\n",
    );
    write(
      "app/graphql/queries/campaign_query.rb",
      "class Queries::CampaignQuery < Queries::BaseQuery\n  type Types::CampaignType, null: true\nend\n",
    );
    const queryType = write(
      "app/graphql/types/query_type.rb",
      "class Types::QueryType < Types::BaseObject\n  field :campaign, resolver: Queries::CampaignQuery\nend\n",
    );
    expect(await gapsOfOnlyField(queryType)).toEqual([
      "Nothing this unit's body does matches a shape this pack looks for, so what it does is not described here",
    ]);
  });

  it("reads the arguments a wired class inherits from its base class", async () => {
    write(
      "app/graphql/queries/base_query.rb",
      "class Queries::BaseQuery < GraphQL::Schema::Resolver\n  argument :account_id, ID, required: true\n\n  def resolve(account_id:)\n    account_id\n  end\nend\n",
    );
    write(
      "app/graphql/queries/campaign_query.rb",
      "class Queries::CampaignQuery < Queries::BaseQuery\n  type Types::CampaignType, null: true\nend\n",
    );
    const queryType = write(
      "app/graphql/types/query_type.rb",
      "class Types::QueryType < Types::BaseObject\n  field :campaign, resolver: Queries::CampaignQuery\nend\n",
    );
    const { summaries } = await extractRubyProject({
      files: [queryType],
      packs: [graphqlRubyPack(path.join(tmpDir, "app", "graphql"))],
    });
    expect(summaries[0]?.metadata?.graphql).toMatchObject({
      declaredContract: {
        args: [{ name: "accountId", type: { type: "text" }, required: true }],
      },
    });
  });

  it("takes the concern Ruby takes when two concerns share a base that also defines the method", async () => {
    write(
      "app/graphql/concerns/base_greeter.rb",
      "module Concerns::BaseGreeter\n  def display_name\n  end\nend\n",
    );
    write(
      "app/graphql/concerns/greeter_a.rb",
      "module Concerns::GreeterA\n  include Concerns::BaseGreeter\n\n  def display_name\n    object.name\n  end\nend\n",
    );
    write(
      "app/graphql/concerns/greeter_b.rb",
      "module Concerns::GreeterB\n  include Concerns::BaseGreeter\nend\n",
    );
    const organizerType = write(
      "app/graphql/types/organizer_type.rb",
      "class Types::OrganizerType < Types::BaseObject\n  include Concerns::GreeterA\n  include Concerns::GreeterB\n\n  field :display_name, String, null: false\nend\n",
    );
    // Ruby calls GreeterA's, which has work in it. Reading BaseGreeter's
    // instead would report a body with nothing in it and no gap at all.
    expect(await gapsOfOnlyField(organizerType)).toEqual([
      "Nothing this unit's body does matches a shape this pack looks for, so what it does is not described here",
    ]);
  });

  it("mixes a module in once when two includes name it", async () => {
    write(
      "app/graphql/concerns/greeter.rb",
      "module Concerns::Greeter\n  def display_name\n    object.name\n  end\nend\n",
    );
    const organizerType = write(
      "app/graphql/types/organizer_type.rb",
      "class Types::OrganizerType < Types::BaseObject\n  include Concerns::Greeter\n  include Concerns::Greeter\n\n  field :display_name, String, null: false\nend\n",
    );
    expect(await gapsOfOnlyField(organizerType)).toEqual([
      "Nothing this unit's body does matches a shape this pack looks for, so what it does is not described here",
    ]);
  });

  it("names a mixin written as something other than a constant path", async () => {
    const organizerType = write(
      "app/graphql/types/organizer_type.rb",
      "class Types::OrganizerType < Types::BaseObject\n  include concern_for(:display)\n\n  field :display_name, String, null: false\nend\n",
    );
    expect(await gapsOfOnlyField(organizerType)).toEqual([
      "This field could be answered by a method inherited from concern_for(:display), which this run did not read, so whether one exists was not settled here",
    ]);
  });

  it("will not answer with a method further along than an ancestor it could not read", async () => {
    write(
      "app/graphql/concerns/known.rb",
      "module Concerns::Known\n  def display_name\n    object.name\n  end\nend\n",
    );
    const organizerType = write(
      "app/graphql/types/organizer_type.rb",
      "class Types::OrganizerType < Types::BaseObject\n  include Concerns::Known\n  include Concerns::Missing\n\n  field :display_name, String, null: false\nend\n",
    );
    expect(await gapsOfOnlyField(organizerType)).toEqual([
      "This field could be answered by a method inherited from Concerns::Missing, which this run did not read, so whether one exists was not settled here",
    ]);
  });

  it("will not say a field has no method while a concern it could not read might define one", async () => {
    const organizerType = write(
      "app/graphql/types/organizer_type.rb",
      "class Types::OrganizerType < Types::BaseObject\n  include Concerns::Displayable\n\n  field :display_name, String, null: false\nend\n",
    );
    expect(await gapsOfOnlyField(organizerType)).toEqual([
      "This field could be answered by a method inherited from Concerns::Displayable, which this run did not read, so whether one exists was not settled here",
    ]);
  });

  it("will not say a field has no method while define_method might have defined one", async () => {
    const organizerType = write(
      "app/graphql/types/organizer_type.rb",
      "class Types::OrganizerType < Types::BaseObject\n  define_method(:display_name) { object.name }\n\n  field :display_name, String, null: false\nend\n",
    );
    expect(await gapsOfOnlyField(organizerType)).toEqual([
      "This field could be answered by a method defined with define_method, which this reader does not follow, so whether one exists was not settled here",
    ]);
  });

  it("says a field whose whole ancestry it read has no method behind it", async () => {
    const campaignType = write(
      "app/graphql/types/campaign_type.rb",
      "class Types::CampaignType < Types::BaseObject\n  field :id, ID, null: false\nend\n",
    );
    expect(await gapsOfOnlyField(campaignType)).toEqual([
      "This unit is a declaration with no body behind it, so nothing about what it does was read here",
    ]);
  });

  it("says nothing at all about a method it read that has nothing in it", async () => {
    const organizerType = write(
      "app/graphql/types/organizer_type.rb",
      "class Types::OrganizerType < Types::BaseObject\n  field :status, String, null: true\n\n  def status\n  end\nend\n",
    );
    expect(await gapsOfOnlyField(organizerType)).toEqual([]);
  });

  it("names the wired class it could not reach, and says nothing else", async () => {
    const queryType = write(
      "app/graphql/types/query_type.rb",
      "class Types::QueryType < Types::BaseObject\n  field :campaign, resolver: Queries::CampaignQuery\nend\n",
    );
    expect(await gapsOfOnlyField(queryType)).toEqual([
      "This field is wired to Queries::CampaignQuery, which this run did not read, so nothing about what it does was read here",
    ]);
  });

  it("says a wired class whose whole ancestry it read defines no resolver method", async () => {
    write(
      "app/graphql/queries/campaign_query.rb",
      "class Queries::CampaignQuery < Queries::BaseQuery\n  type Types::CampaignType, null: true\nend\n",
    );
    const queryType = write(
      "app/graphql/types/query_type.rb",
      "class Types::QueryType < Types::BaseObject\n  field :campaign, resolver: Queries::CampaignQuery\nend\n",
    );
    expect(await gapsOfOnlyField(queryType)).toEqual([
      "This field is wired to Queries::CampaignQuery, which defines no resolve method anywhere in its ancestry, so nothing about what it does was read here",
    ]);
  });

  it("names a wiring value it cannot follow, and says nothing else", async () => {
    const queryType = write(
      "app/graphql/types/query_type.rb",
      "class Types::QueryType < Types::BaseObject\n  field :campaign, resolver: resolver_for(:campaign)\nend\n",
    );
    expect(await gapsOfOnlyField(queryType)).toEqual([
      "This field is wired to resolver_for(:campaign), which is not a constant path this reader follows, so nothing about what it does was read here",
    ]);
  });
});
