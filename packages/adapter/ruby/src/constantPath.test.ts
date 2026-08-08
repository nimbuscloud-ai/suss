import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveConstantFile, underscoreConstantPath } from "./constantPath.js";

describe("underscoreConstantPath", () => {
  it("converts a namespaced constant to a nested snake_case path", () => {
    expect(underscoreConstantPath("Mutations::CampaignUpdate")).toBe(
      "mutations/campaign_update",
    );
  });

  it("converts a namespaced query constant the same way", () => {
    expect(underscoreConstantPath("Queries::CampaignQuery")).toBe(
      "queries/campaign_query",
    );
  });

  it("underscores a bare constant with no namespace", () => {
    expect(underscoreConstantPath("CampaignType")).toBe("campaign_type");
  });

  it("does not insert an underscore inside a run of consecutive capitals", () => {
    expect(underscoreConstantPath("Types::ISO8601DateTime")).toBe(
      "types/iso8601_date_time",
    );
  });
});

describe("resolveConstantFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-ruby-constant-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves a constant to the file its underscored path names", () => {
    const file = path.join(tmpDir, "mutations", "campaign_update.rb");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "class Mutations::CampaignUpdate\nend\n");

    expect(
      resolveConstantFile(
        tmpDir,
        "Mutations::CampaignUpdate",
        "railsUnderscore",
      ),
    ).toBe(file);
  });

  it("is null when no file sits at the conventional path", () => {
    expect(
      resolveConstantFile(tmpDir, "Mutations::DoesNotExist", "railsUnderscore"),
    ).toBeNull();
  });
});
