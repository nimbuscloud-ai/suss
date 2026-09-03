import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { graphqlRubyTestPack } from "./__fixtures__/graphqlRubyPattern.js";
import { extractRubyProject, findRubyFiles } from "./project.js";

import type { ExtractionReport, TimingReport } from "@suss/extractor";
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

describe("environment reads on a summary", () => {
  it("puts a resolver body's reads on the field and a file's load-time reads on a module-init unit", async () => {
    const campaignType = write(
      "app/graphql/types/campaign_type.rb",
      [
        'PAGE_SIZE = ENV.fetch("PAGE_SIZE", "20")',
        "",
        "class Types::CampaignType < Types::BaseObject",
        "  field :banner, String, null: false",
        "",
        "  def banner",
        '    ENV["BANNER_BUCKET"]',
        "  end",
        "end",
        "",
      ].join("\n"),
    );
    const { summaries } = await extractRubyProject({
      files: [campaignType],
      packs: [graphqlRubyPack(path.join(tmpDir, "app", "graphql"))],
      workspaceRoot: tmpDir,
    });

    const configReads = (summary: (typeof summaries)[number] | undefined) =>
      summary?.transitions.flatMap((t) =>
        t.effects.flatMap((effect) =>
          effect.type === "interaction" &&
          effect.interaction.class === "config-read"
            ? [effect.interaction]
            : [],
        ),
      );
    const field = summaries.find((s) => s.identity.name === "Campaign.banner");
    expect(configReads(field)).toEqual([
      { class: "config-read", name: "BANNER_BUCKET", defaulted: false },
    ]);

    const moduleInit = summaries.find((s) => s.kind === "module-init");
    expect(moduleInit?.identity.name).toBe("campaign_type.rb");
    expect(moduleInit?.location.file).toBe(
      "app/graphql/types/campaign_type.rb",
    );
    expect(configReads(moduleInit)).toEqual([
      { class: "config-read", name: "PAGE_SIZE", defaulted: true },
    ]);
  });
});

describe("module imports on a summary", () => {
  it("records the files a require_relative resolves to and the files whose constants the file reads", async () => {
    const settings = write(
      "app/graphql/settings.rb",
      'module Settings\n  REGION = ENV.fetch("REGION", "us-east-1")\nend\n',
    );
    const helpers = write(
      "app/graphql/types/helpers.rb",
      "module Helpers\nend\n",
    );
    const campaignType = write(
      "app/graphql/types/campaign_type.rb",
      [
        'require_relative "helpers"',
        "",
        "class Types::CampaignType < Types::BaseObject",
        "  field :region, String, null: false",
        "",
        "  def region",
        "    Settings::REGION",
        "  end",
        "end",
        "",
      ].join("\n"),
    );
    const { summaries } = await extractRubyProject({
      files: [settings, helpers, campaignType],
      packs: [graphqlRubyPack(path.join(tmpDir, "app", "graphql"))],
      workspaceRoot: tmpDir,
    });

    const field = summaries.find((s) => s.identity.name === "Campaign.region");
    expect(field?.metadata?.moduleImports).toEqual([
      "app/graphql/settings.rb",
      "app/graphql/types/helpers.rb",
    ]);
    const settingsInit = summaries.find(
      (s) => s.location.file === "app/graphql/settings.rb",
    );
    expect(settingsInit?.kind).toBe("module-init");
    expect(settingsInit?.metadata?.moduleImports).toEqual([]);
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

  it("finds the resolve method a wired class inherits, and leaves its unbound scope call as a gap", async () => {
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
      "The call to scope.find_by goes through a value this run could not settle, so whatever runs there is missing from this summary",
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

  it("puts the database work a resolver method does on the field's transitions", async () => {
    const graphqlRoot = path.join(tmpDir, "app", "graphql");
    const orderType = write(
      "app/graphql/types/order_type.rb",
      [
        "class Types::OrderType < Types::BaseObject",
        "  field :total, Integer, null: false",
        "",
        "  def total",
        "    Order.where(id: 1).first",
        "  end",
        "end",
        "",
      ].join("\n"),
    );
    write(
      "app/models/order.rb",
      ["class Order < ApplicationRecord", "end", ""].join("\n"),
    );
    const models = write(
      "app/models/application_record.rb",
      ["class ApplicationRecord < ActiveRecord::Base", "end", ""].join("\n"),
    );

    const pack: RubyPack = {
      ...graphqlRubyPack(graphqlRoot),
      storage: [
        {
          baseClasses: ["ActiveRecord::Base"],
          writes: ["update", "destroy", "save"],
          storageSystem: "postgresql",
        },
      ],
    };
    const { summaries } = await extractRubyProject({
      files: [orderType, path.join(tmpDir, "app/models/order.rb"), models],
      packs: [pack],
    });

    const storage = summaries
      .flatMap((summary) =>
        (summary.transitions ?? []).flatMap((transition) => transition.effects),
      )
      .filter(
        (effect) =>
          effect.type === "interaction" &&
          effect.interaction.class === "storage-access",
      );
    expect(storage).toHaveLength(1);
  });
});

describe("the extraction report", () => {
  it("counts files, units and summaries by pack, and times each phase", async () => {
    const graphqlRoot = path.join(tmpDir, "app", "graphql");
    const campaignType = write(
      "app/graphql/types/campaign_type.rb",
      "class Types::CampaignType < Types::BaseObject\n  field :id, ID, null: false\nend\n",
    );
    const notAType = write(
      "app/graphql/types/README.rb",
      "# not a graphql type\n",
    );

    let report: ExtractionReport | undefined;
    let timing: TimingReport | undefined;
    await extractRubyProject({
      files: [campaignType, notAType],
      packs: [graphqlRubyPack(graphqlRoot)],
      workspaceRoot: tmpDir,
      onExtractionReport: (r) => {
        report = r;
      },
      onTiming: (t) => {
        timing = t;
      },
    });

    expect(report?.filesWalked).toBe(2);
    expect(report?.summaries).toBe(1);
    const funnel = report?.packs.find((p) => p.pack === "graphql-ruby");
    expect(funnel?.gates).toEqual([]);
    expect(funnel?.candidateFiles).toBe(2);
    expect(funnel?.unitsDiscovered).toBe(1);
    expect(funnel?.summariesProduced).toBe(1);
    expect(funnel?.summariesBound).toBe(1);

    const phases = new Set(timing?.phases.map((phase) => phase.label));
    expect(phases).toEqual(new Set(["parse", "discover", "summarize"]));
  });

  it("blames discovery when files were found but no field matched", async () => {
    const file = write(
      "app/graphql/my_app_schema.rb",
      "class MyAppSchema < GraphQL::Schema\n  query Types::QueryType\nend\n",
    );

    let report: ExtractionReport | undefined;
    await extractRubyProject({
      files: [file],
      packs: [graphqlRubyPack(path.join(tmpDir, "app", "graphql"))],
      onExtractionReport: (r) => {
        report = r;
      },
    });

    expect(report?.summaries).toBe(0);
    expect(report?.emptyStage).toBe("discovery");
  });
});
