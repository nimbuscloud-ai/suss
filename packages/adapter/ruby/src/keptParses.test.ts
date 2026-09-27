/**
 * A run given the trees an earlier run left has to say what a run that
 * parsed everything says. A process that reads a project after every
 * edit keeps one holder, and only the files whose text changed are
 * parsed again.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { graphqlRubyTestPack } from "./__fixtures__/graphqlRubyPattern.js";
import {
  extractRubyProject,
  findRubyFiles,
  keptRubyParses,
  parseRubyAhead,
} from "./project.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-ruby-kept-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(relPath: string, content: string): void {
  const full = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function campaignType(fields: string): string {
  return `class Types::CampaignType < Types::BaseObject\n${fields}end\n`;
}

function schemaProject(): string[] {
  write(
    "app/graphql/types/campaign_type.rb",
    campaignType("  field :id, ID, null: false\n"),
  );
  return findRubyFiles(tmpDir);
}

async function run(
  files: string[],
  keptParses?: ReturnType<typeof keptRubyParses>,
) {
  const { summaries } = await extractRubyProject({
    files,
    packs: [graphqlRubyTestPack({ root: path.join(tmpDir, "app", "graphql") })],
    projectRoot: tmpDir,
    cacheDir: null,
    ...(keptParses !== undefined ? { keptParses } : {}),
  });
  return JSON.stringify(summaries);
}

describe("a Ruby run with kept parses", () => {
  it("says what a run that parsed everything says, after an edit", async () => {
    const files = schemaProject();
    const kept = keptRubyParses();
    const before = await run(files, kept);

    write(
      "app/graphql/types/campaign_type.rb",
      campaignType("  field :id, ID, null: false\n  field :name, String\n"),
    );
    const after = await run(files, kept);

    expect(after).not.toEqual(before);
    expect(after).toEqual(await run(files));
  });

  it("serves a run from trees parsed ahead of it", async () => {
    const files = schemaProject();
    const kept = keptRubyParses();
    await parseRubyAhead(files, kept);

    expect(await run(files, kept)).toEqual(await run(files));
  });
});
