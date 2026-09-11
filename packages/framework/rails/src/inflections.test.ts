import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  inflectionFiles,
  readAcronyms,
  readInflections,
} from "./inflections.js";

describe("readAcronyms", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-rails-inflect-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeInitializer(relative: string, source: string): string {
    const file = path.join(tmpDir, "config", "initializers", relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
    return file;
  }

  it("reads every acronym the inflections initializer registers", () => {
    writeInitializer(
      "inflections.rb",
      [
        "ActiveSupport::Inflector.inflections(:en) do |inflect|",
        "  inflect.acronym 'ActivityPub'",
        '  inflect.acronym "OEmbed"',
        "  inflect.acronym('OAuth')",
        "  inflect.irregular 'person', 'people'",
        "end",
      ].join("\n"),
    );

    expect(readAcronyms(tmpDir)).toEqual(["ActivityPub", "OAuth", "OEmbed"]);
  });

  it("reads an acronym registered from any initializer, since Rails runs them all", () => {
    writeInitializer("inflections.rb", "inflect.acronym 'API'\n");
    writeInitializer(
      "vendor/extra_inflections.rb",
      "ActiveSupport::Inflector.inflections { |i| i.acronym 'HTML' }\n",
    );
    writeInitializer("cors.rb", "Rails.application.config.middleware\n");

    expect(readAcronyms(tmpDir)).toEqual(["API", "HTML"]);
    expect(inflectionFiles(tmpDir)).toEqual([
      path.join(tmpDir, "config", "initializers", "inflections.rb"),
      path.join(
        tmpDir,
        "config",
        "initializers",
        "vendor",
        "extra_inflections.rb",
      ),
    ]);
  });

  it("leaves an acronym built at runtime unread", () => {
    writeInitializer(
      "inflections.rb",
      "ACRONYMS.each { |word| inflect.acronym word }\n",
    );

    expect(readAcronyms(tmpDir)).toEqual([]);
  });

  it("is empty for a project with no initializers", () => {
    expect(readAcronyms(tmpDir)).toEqual([]);
    expect(inflectionFiles(tmpDir)).toEqual([]);
  });

  it("reads the irregulars, uncountables and singular rules beside the acronyms", () => {
    writeInitializer(
      "inflections.rb",
      [
        "ActiveSupport::Inflector.inflections(:en) do |inflect|",
        '  inflect.acronym "API"',
        '  inflect.irregular "person", "people"',
        "  inflect.uncountable %w( fish sheep )",
        '  inflect.uncountable "equipment"',
        "  inflect.singular 'data', 'data'",
        "  inflect.singular(/(quiz)zes$/i, '\\1')",
        "end",
      ].join("\n"),
    );

    expect(readInflections(tmpDir)).toEqual({
      acronyms: ["API"],
      irregular: [["people", "person"]],
      uncountable: ["equipment", "fish", "sheep"],
      singular: [
        ["data", "data"],
        ["/(quiz)zes$/i", "\\1"],
      ],
    });
  });

  it("leaves the scaffolded file's commented-out examples unread", () => {
    writeInitializer(
      "inflections.rb",
      [
        "# ActiveSupport::Inflector.inflections(:en) do |inflect|",
        '#   inflect.irregular "person", "people"',
        "#   inflect.uncountable %w( fish sheep )",
        "# end",
        "",
        "ActiveSupport::Inflector.inflections(:en) do |inflect|",
        '  inflect.acronym "API"',
        "end",
      ].join("\n"),
    );

    expect(readInflections(tmpDir)).toEqual({
      acronyms: ["API"],
      irregular: [],
      uncountable: [],
      singular: [],
    });
  });
});
