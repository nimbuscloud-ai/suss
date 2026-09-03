/**
 * The on-disk extraction cache, exercised against a temp directory.
 *
 * Running under vitest gives the adapter a "source" code stamp, and a
 * run from source always declines to cache. `./version.js` is mocked
 * here so `adapterStamp.declineWhenRunFromSource` passes `cacheDir`
 * through unchanged. That is what puts the cache layer itself under
 * test, the same one a built CLI run reaches.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./version.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./version.js")>();
  return {
    ...actual,
    adapterStamp: {
      ...actual.adapterStamp,
      declineWhenRunFromSource: (cacheDir: string | null) => cacheDir,
    },
  };
});

import { graphqlRubyTestPack } from "./__fixtures__/graphqlRubyPattern.js";
import { extractRubyProject, findRubyFiles } from "./project.js";

import type { CacheDiagnostic } from "@suss/extractor";
import type { RubyPack } from "./pack.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-ruby-cache-"));
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

function schemaProject(): string[] {
  write(
    "app/graphql/types/campaign_type.rb",
    "class Types::CampaignType < Types::BaseObject\n  field :id, ID, null: false\nend\n",
  );
  return findRubyFiles(tmpDir);
}

function testPacks(): RubyPack[] {
  return [graphqlRubyTestPack({ root: path.join(tmpDir, "app", "graphql") })];
}

describe("extractRubyProject's on-disk cache", () => {
  it("misses the first run and hits the second over unchanged files", async () => {
    const files = schemaProject();
    const packs = testPacks();
    const diagnostics: CacheDiagnostic[] = [];
    const onCacheDiagnostic = (d: CacheDiagnostic) => diagnostics.push(d);

    const first = await extractRubyProject({
      files,
      packs,
      projectRoot: tmpDir,
      onCacheDiagnostic,
    });
    const second = await extractRubyProject({
      files,
      packs,
      projectRoot: tmpDir,
      onCacheDiagnostic,
    });

    expect(first.summaries.length).toBeGreaterThan(0);
    expect(diagnostics[0]?.kind).toBe("miss");
    expect(diagnostics[1]).toEqual({ kind: "hit" });
    expect(second.summaries).toEqual(first.summaries);
  });

  it("misses with files-changed once a walked file's content changes", async () => {
    const files = schemaProject();
    const packs = testPacks();
    const diagnostics: CacheDiagnostic[] = [];
    const onCacheDiagnostic = (d: CacheDiagnostic) => diagnostics.push(d);

    await extractRubyProject({
      files,
      packs,
      projectRoot: tmpDir,
      onCacheDiagnostic,
    });
    write(
      "app/graphql/types/campaign_type.rb",
      "class Types::CampaignType < Types::BaseObject\n  field :id, ID, null: false\n  field :name, String, null: false\nend\n",
    );
    await extractRubyProject({
      files,
      packs,
      projectRoot: tmpDir,
      onCacheDiagnostic,
    });

    expect(diagnostics[1]).toEqual({
      kind: "miss",
      missReason: "files-changed",
    });
  });

  it("misses with key-changed once a pack's declared version changes", async () => {
    const files = schemaProject();
    const packs = testPacks();
    const diagnostics: CacheDiagnostic[] = [];
    const onCacheDiagnostic = (d: CacheDiagnostic) => diagnostics.push(d);

    await extractRubyProject({
      files,
      packs,
      projectRoot: tmpDir,
      onCacheDiagnostic,
    });
    await extractRubyProject({
      files,
      packs: [{ ...packs[0], version: "2" }],
      projectRoot: tmpDir,
      onCacheDiagnostic,
    });

    expect(diagnostics[1]).toEqual({ kind: "miss", missReason: "key-changed" });
  });

  it("misses with key-changed once a file a pack reads without walking changes", async () => {
    const files = schemaProject();
    const routes = write("config/routes.rb", "get 'a', to: 'a#show'\n");
    const packs = testPacks().map((pack) => ({
      ...pack,
      discoveryInputs: () => [routes],
    }));
    const diagnostics: CacheDiagnostic[] = [];
    const onCacheDiagnostic = (d: CacheDiagnostic) => diagnostics.push(d);

    await extractRubyProject({
      files,
      packs,
      projectRoot: tmpDir,
      onCacheDiagnostic,
    });
    fs.writeFileSync(routes, "get 'b', to: 'b#show'\n");
    await extractRubyProject({
      files,
      packs,
      projectRoot: tmpDir,
      onCacheDiagnostic,
    });

    expect(diagnostics[1]).toEqual({ kind: "miss", missReason: "key-changed" });
  });

  it("never writes an entry when cacheDir is null", async () => {
    const files = schemaProject();
    const packs = testPacks();

    await extractRubyProject({
      files,
      packs,
      projectRoot: tmpDir,
      cacheDir: null,
    });
    await extractRubyProject({
      files,
      packs,
      projectRoot: tmpDir,
      cacheDir: null,
    });

    expect(fs.existsSync(path.join(tmpDir, ".suss", "cache"))).toBe(false);
  });
});
