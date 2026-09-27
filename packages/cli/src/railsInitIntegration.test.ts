/**
 * Setting up a Rails app with a GraphQL API the way the agent setup
 * prompt does: `suss init --write`, then `suss extract --out-dir`. The
 * graphql-ruby and activerecord packs refuse to run without a config
 * file, so init has to write one for each and list it in `suss.json`, or
 * the whole Ruby read fails.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCli } from "./run.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const FIXTURE = path.resolve(__dirname, "../../../fixtures/rails-graphql-app");

let work: string;
let project: string;

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "suss-rails-init-"));
  project = path.join(work, "orders");
  fs.cpSync(FIXTURE, project, { recursive: true });
});

afterEach(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

async function quietly(
  args: string[],
): Promise<{ exit: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const writeOut = process.stdout.write.bind(process.stdout);
  const writeErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string) => {
    out.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => {
    err.push(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    const exit = await runCli(args);
    return { exit, stdout: out.join(""), stderr: err.join("") };
  } finally {
    process.stdout.write = writeOut;
    process.stderr.write = writeErr;
  }
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function rubyPacks(): string[] {
  const written = readJson<{
    read: Array<{ kind: string; language?: string; packs?: string[] }>;
  }>(path.join(project, "suss.json"));
  const ruby = written.read.find(
    (entry) => entry.kind === "extract" && entry.language === "ruby",
  );
  return ruby?.packs ?? [];
}

describe("init --write on a Rails app with a GraphQL API", () => {
  it("writes each pack's config and lists it, so the extract after it reads the app", async () => {
    const init = await quietly(["init", project, "--write"]);
    expect(init.exit).toBe(0);

    expect(rubyPacks()).toEqual(
      expect.arrayContaining([
        "graphql-ruby=suss.graphql-ruby.json",
        "rails=suss.rails.json",
        "activerecord=suss.activerecord.json",
      ]),
    );
    expect(readJson(path.join(project, "suss.graphql-ruby.json"))).toEqual({
      root: "app/graphql",
    });
    expect(readJson(path.join(project, "suss.activerecord.json"))).toEqual({
      storageSystem: "postgresql",
    });

    const out = path.join(work, "summaries");
    const extract = await quietly([
      "extract",
      "--out-dir",
      out,
      "--dir",
      project,
    ]);
    expect(extract.stderr).not.toContain("failed:");
    expect(extract.exit).toBe(0);

    const summaries = fs
      .readdirSync(out)
      .flatMap((name) => readJson<BehavioralSummary[]>(path.join(out, name)));
    const names = summaries.map((summary) => summary.identity.name);
    expect(names).toEqual(
      expect.arrayContaining(["index", "show", "Query.order"]),
    );
    // The activerecord pack ran with the database init read from database.yml.
    expect(JSON.stringify(summaries)).toContain('"postgresql"');
  });

  it("leaves activerecord out, and says why, when database.yml does not say which database", async () => {
    fs.rmSync(path.join(project, "config", "database.yml"));

    const init = await quietly(["init", project, "--write"]);

    expect(init.exit).toBe(0);
    expect(init.stdout).toContain("Left activerecord out of suss.json");
    expect(init.stdout).toContain("suss.activerecord.json");
    expect(rubyPacks()).not.toContainEqual(
      expect.stringContaining("activerecord"),
    );
    expect(fs.existsSync(path.join(project, "suss.activerecord.json"))).toBe(
      false,
    );

    const extract = await quietly([
      "extract",
      "--out-dir",
      path.join(work, "summaries"),
      "--dir",
      project,
    ]);
    expect(extract.stderr).not.toContain("failed:");
    expect(extract.exit).toBe(0);
  });

  it("keeps a pack config the project already has, and lists it", async () => {
    fs.writeFileSync(
      path.join(project, "suss.activerecord.json"),
      '{ "storageSystem": "mysql" }\n',
    );

    await quietly(["init", project, "--write"]);

    expect(rubyPacks()).toContain("activerecord=suss.activerecord.json");
    expect(readJson(path.join(project, "suss.activerecord.json"))).toEqual({
      storageSystem: "mysql",
    });
  });
});
