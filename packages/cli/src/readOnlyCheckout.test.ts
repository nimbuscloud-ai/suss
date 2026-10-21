// A run in a checkout nobody may write to succeeds when the cache goes
// somewhere else. The binary loads the adapters from its bundle, so the
// on-disk cache is on here the way it is for a user.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const BIN = path.resolve(__dirname, "../dist/bin.js");
const FIXTURES = path.resolve(__dirname, "../../../fixtures");

/** A root user can write anywhere, so a read-only directory proves nothing. */
const canTestReadOnly = process.getuid?.() !== 0;

let scratch: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "suss-read-only-"));
});

afterEach(() => {
  makeWritable(scratch);
  fs.rmSync(scratch, { recursive: true, force: true });
});

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? [full, ...walk(full)] : [full];
  });
}

function makeReadOnly(dir: string): void {
  for (const entry of walk(dir)) {
    fs.chmodSync(entry, fs.statSync(entry).isDirectory() ? 0o555 : 0o444);
  }
  fs.chmodSync(dir, 0o555);
}

function makeWritable(dir: string): void {
  if (!fs.existsSync(dir)) {
    return;
  }
  fs.chmodSync(dir, 0o755);
  for (const entry of walk(dir)) {
    fs.chmodSync(entry, fs.statSync(entry).isDirectory() ? 0o755 : 0o644);
  }
}

/** Every path under `dir` with its size and modified time. */
function snapshot(dir: string): string[] {
  return [dir, ...walk(dir)].map((entry) => {
    const stat = fs.statSync(entry);
    return `${path.relative(dir, entry)} ${stat.size} ${stat.mtimeMs}`;
  });
}

function copyFixture(name: string): string {
  const target = path.join(scratch, name);
  // Other tests extract these fixtures in place and leave a cache behind.
  fs.cpSync(path.join(FIXTURES, name), target, {
    recursive: true,
    filter: (source) => path.basename(source) !== ".suss",
  });
  return target;
}

function suss(
  args: string[],
  options: { env?: Record<string, string>; cwd?: string } = {},
): { status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    env: { ...process.env, SUSS_NO_UPDATE_NOTICE: "1", ...options.env },
  });
  return { status: result.status, stderr: result.stderr };
}

/** A tsconfig is what gives the TypeScript adapter a place to keep a cache. */
function addTsconfig(project: string): void {
  fs.writeFileSync(
    path.join(project, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true }, include: ["."] }),
  );
}

const READS: Array<{
  name: string;
  fixture: string;
  args: string[];
  prepare?: (project: string) => void;
}> = [
  {
    name: "ruby",
    fixture: "ruby-rails",
    args: ["--lang", "ruby", "-f", "rails"],
  },
  {
    name: "python",
    fixture: "python-webapp",
    args: ["--lang", "python", "-f", "fastapi"],
  },
  {
    name: "typescript with a tsconfig",
    fixture: "express-helpers",
    args: ["-f", "express"],
    prepare: addTsconfig,
  },
];

describe.skipIf(!canTestReadOnly)("a checkout nobody may write to", () => {
  it.each(READS)(
    "extracts $name with --cache-dir and leaves the project unchanged",
    ({ fixture, args, prepare }) => {
      const project = copyFixture(fixture);
      prepare?.(project);
      const cacheDir = path.join(scratch, "cache");
      const output = path.join(scratch, "summaries.json");
      makeReadOnly(project);
      const before = snapshot(project);

      const run = suss([
        "extract",
        "--dir",
        project,
        ...args,
        "--cache-dir",
        cacheDir,
        "-o",
        output,
      ]);

      expect(run.stderr).not.toMatch(/EACCES|EPERM/);
      expect(run.status).toBe(0);
      expect(snapshot(project)).toEqual(before);
      expect(fs.existsSync(path.join(project, ".suss"))).toBe(false);
      expect(fs.existsSync(output)).toBe(true);
      expect(fs.existsSync(path.join(cacheDir, "cache"))).toBe(true);
    },
  );

  it("reads SUSS_CACHE_DIR when no flag is given, and the flag wins over it", () => {
    const project = copyFixture("ruby-rails");
    const fromEnv = path.join(scratch, "from-env");
    const fromFlag = path.join(scratch, "from-flag");
    makeReadOnly(project);
    const base = ["extract", "--dir", project, "--lang", "ruby", "-f", "rails"];

    const viaEnv = suss([...base, "-o", path.join(scratch, "a.json")], {
      env: { SUSS_CACHE_DIR: fromEnv },
    });
    expect(viaEnv.status).toBe(0);
    expect(fs.existsSync(path.join(fromEnv, "cache"))).toBe(true);

    const viaFlag = suss(
      [...base, "--cache-dir", fromFlag, "-o", path.join(scratch, "b.json")],
      { env: { SUSS_CACHE_DIR: path.join(scratch, "ignored") } },
    );
    expect(viaFlag.status).toBe(0);
    expect(fs.existsSync(path.join(fromFlag, "cache"))).toBe(true);
    expect(fs.existsSync(path.join(scratch, "ignored"))).toBe(false);
  });

  it("checks a project it extracts itself without writing into it", () => {
    const project = copyFixture("ruby-rails");
    fs.writeFileSync(
      path.join(project, "suss.json"),
      JSON.stringify({
        version: 1,
        read: [{ kind: "extract", language: "ruby", packs: ["rails"] }],
      }),
    );
    makeReadOnly(project);
    const before = snapshot(project);

    const run = suss(
      ["check", "--allow-empty", "--cache-dir", path.join(scratch, "cache")],
      { cwd: project },
    );

    expect(run.stderr).not.toMatch(/EACCES|EPERM/);
    expect(snapshot(project)).toEqual(before);
    expect(fs.existsSync(path.join(scratch, "cache", "cache"))).toBe(true);
  });
});
