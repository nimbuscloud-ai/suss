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
