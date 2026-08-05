// A second run answers with what the first one said.
//
// The extraction cache short-circuits before the summaries are named,
// so a run served from it handed back ids of null, no workspace, and a
// call graph with nothing in it. Every second run, and every CI job
// that keeps a cache directory.
//
// This has to run the built binary. The cache turns itself off when the
// adapter is loaded from source, so an in-process test never reaches
// the path that broke, and a test written that way passes whether the
// bug is there or not. It was.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const BIN = path.resolve(__dirname, "../dist/bin.js");
const EXPRESS_FIXTURES = path.resolve(__dirname, "../../../fixtures/express");
const REPO_MODULES = path.resolve(__dirname, "../../../node_modules");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suss-warm-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "warm-fixture" }),
  );
  fs.writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        esModuleInterop: true,
        noEmit: true,
      },
      include: ["src"],
    }),
  );
  // The express fixture, with the repository's modules behind it, so
  // the pack's import gate resolves the way it does for a user.
  for (const file of fs.readdirSync(EXPRESS_FIXTURES)) {
    if (file.endsWith(".ts")) {
      fs.copyFileSync(
        path.join(EXPRESS_FIXTURES, file),
        path.join(root, "src", file),
      );
    }
  }
  fs.symlinkSync(REPO_MODULES, path.join(root, "node_modules"));
  return root;
}

function extract(root: string, out: string): unknown[] {
  const result = spawnSync(
    process.execPath,
    [BIN, "extract", "-p", "tsconfig.json", "-f", "express", "-o", out],
    { cwd: root, encoding: "utf8", timeout: 180_000 },
  );
  if (result.status !== 0) {
    throw new Error(`extract failed: ${result.stderr}`);
  }
  return JSON.parse(fs.readFileSync(path.join(root, out), "utf8"));
}

const named = (summaries: unknown[]) =>
  (summaries as Array<Record<string, never>>).map((s) => {
    const summary = s as unknown as {
      identity: { id?: string };
      location: { workspace?: string };
    };
    return {
      id: summary.identity.id ?? null,
      workspace: summary.location.workspace ?? null,
    };
  });

describe("a second run", () => {
  it("says what the first one said", () => {
    const root = fixture();

    const cold = named(extract(root, "cold.json"));
    const warm = named(extract(root, "warm.json"));

    // The run has to be worth something before agreeing means anything.
    expect(cold.length).toBeGreaterThan(0);
    expect(cold[0]?.id).not.toBeNull();
    expect(cold[0]?.workspace).toBe("warm-fixture");

    expect(warm).toEqual(cold);
  }, 300_000);
});
