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

  it("keeps a registered acronym as one word, wherever it falls in the name", () => {
    const acronyms = ["ActivityPub", "OEmbed", "OAuth", "HTML"];
    expect(
      underscoreConstantPath("ActivityPub::InboxesController", acronyms),
    ).toBe("activitypub/inboxes_controller");
    expect(underscoreConstantPath("Api::OEmbedController", acronyms)).toBe(
      "api/oembed_controller",
    );
    expect(underscoreConstantPath("OAuth::UserinfoController", acronyms)).toBe(
      "oauth/userinfo_controller",
    );
    expect(underscoreConstantPath("MyHTMLParser", acronyms)).toBe(
      "my_html_parser",
    );
  });

  it("splits the same name the ordinary way when the acronym is not registered", () => {
    expect(underscoreConstantPath("ActivityPub::InboxesController")).toBe(
      "activity_pub/inboxes_controller",
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

  it("finds a constant in a directory Rails autoloads from under the root", () => {
    // Rails autoloads every directory under `app`, so a controller is at
    // `app/controllers/x.rb` rather than `app/x.rb`.
    const file = path.join(tmpDir, "controllers", "application_controller.rb");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "class ApplicationController\nend\n");

    expect(
      resolveConstantFile(tmpDir, "ApplicationController", "railsUnderscore"),
    ).toBe(file);
  });

  it("takes the root's own file over one in a directory under it", () => {
    const atRoot = path.join(tmpDir, "order.rb");
    const nested = path.join(tmpDir, "models", "order.rb");
    fs.mkdirSync(path.dirname(nested), { recursive: true });
    fs.writeFileSync(atRoot, "class Order\nend\n");
    fs.writeFileSync(nested, "class Order\nend\n");

    expect(resolveConstantFile(tmpDir, "Order", "railsUnderscore")).toBe(
      atRoot,
    );
  });

  it("finds a concern in the concerns directory under a directory Rails autoloads from", () => {
    const model = path.join(tmpDir, "models", "concerns", "archivable.rb");
    const controller = path.join(
      tmpDir,
      "controllers",
      "concerns",
      "reporting",
      "paged.rb",
    );
    fs.mkdirSync(path.dirname(model), { recursive: true });
    fs.mkdirSync(path.dirname(controller), { recursive: true });
    fs.writeFileSync(model, "module Archivable\nend\n");
    fs.writeFileSync(controller, "module Reporting::Paged\nend\n");

    expect(resolveConstantFile(tmpDir, "Archivable", "railsUnderscore")).toBe(
      model,
    );
    expect(
      resolveConstantFile(tmpDir, "Reporting::Paged", "railsUnderscore"),
    ).toBe(controller);
  });

  it("takes a file in a directory under the root over one in a concerns directory", () => {
    const direct = path.join(tmpDir, "models", "archivable.rb");
    const concern = path.join(tmpDir, "models", "concerns", "archivable.rb");
    fs.mkdirSync(path.dirname(concern), { recursive: true });
    fs.writeFileSync(direct, "class Archivable\nend\n");
    fs.writeFileSync(concern, "module Archivable\nend\n");

    expect(resolveConstantFile(tmpDir, "Archivable", "railsUnderscore")).toBe(
      direct,
    );
  });
});
