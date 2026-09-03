import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { rubyStubEvidence } from "./stubEvidence.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-ruby-stub-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(relPath: string, content: string): void {
  const full = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe("rubyStubEvidence", () => {
  it("finds a class whose superclass is spelled from the package", async () => {
    write(
      "app/graphql/types/campaign_type.rb",
      "module Types\n  class CampaignType < GraphQL::Schema::Object\n  end\nend\n",
    );

    const evidence = await rubyStubEvidence({
      packageName: "graphql",
      directory: tmpDir,
    });

    expect(evidence.extendsSites).toHaveLength(1);
    expect(evidence.extendsSites[0].className).toBe("Types::CampaignType");
    expect(evidence.extendsSites[0].superclassName).toBe(
      "GraphQL::Schema::Object",
    );
  });

  it("finds a require of the package, and leaves out an unrelated one", async () => {
    write("config/graphql.rb", 'require "graphql"\nrequire "json"\n');

    const evidence = await rubyStubEvidence({
      packageName: "graphql",
      directory: tmpDir,
    });

    expect(evidence.requires).toHaveLength(1);
    expect(evidence.requires[0].target).toBe("graphql");
  });

  it("matches a wrapper gem's own namespace, not the graphql-ruby one", async () => {
    write(
      "app/graphql/types/campaign_type.rb",
      "module Types\n  class CampaignType < AcmeGraphql::AuthenticatedObject\n  end\nend\n",
    );

    const forWrapper = await rubyStubEvidence({
      packageName: "acme_graphql",
      directory: tmpDir,
    });
    expect(forWrapper.extendsSites).toHaveLength(1);
    expect(forWrapper.extendsSites[0].superclassName).toBe(
      "AcmeGraphql::AuthenticatedObject",
    );

    const forGraphql = await rubyStubEvidence({
      packageName: "graphql",
      directory: tmpDir,
    });
    expect(forGraphql.extendsSites).toEqual([]);
  });

  it("matches a hyphenated gem name against its require and its underscored constant", async () => {
    write(
      "app/graphql/types/campaign_type.rb",
      "module Types\n  class CampaignType < AcmeGraphql::AuthenticatedObject\n  end\nend\n",
    );
    write("config/graphql.rb", 'require "acme_graphql"\n');

    const evidence = await rubyStubEvidence({
      packageName: "acme-graphql",
      directory: tmpDir,
    });

    expect(evidence.requires).toHaveLength(1);
    expect(evidence.extendsSites).toHaveLength(1);
  });
});
