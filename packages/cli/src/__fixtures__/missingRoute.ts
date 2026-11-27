/**
 * What the missing-route integration tests share: a copy of a fixture
 * that a test may edit, the commands that read each side of the
 * boundary into one summaries folder, and the missing-route findings a
 * check over that folder reports. Each language's test differs only in
 * the fixtures and the commands it runs.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, expect } from "vitest";

import { quietly } from "./quietly.js";

import type { Finding } from "@suss/behavioral-ir";

const repoRoot = path.resolve(__dirname, "../../../..");

/** A command that writes summaries to `out`, run in `cwd`, or in the app when it has none. */
export interface SummaryCommand {
  cwd?: string;
  argv: (out: string) => string[];
}

/**
 * Returns a function that copies a fixture into a temporary folder for
 * the calling test file. The folder is removed after that file's tests.
 */
export function fixtureCopier(
  prefix: string,
): (fixture: string, label: string) => string {
  let root = "";
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  return (fixture, label) => {
    const at = path.join(root, label);
    fs.cpSync(path.join(repoRoot, "fixtures", fixture), at, {
      recursive: true,
    });
    return at;
  };
}

/** Rewrites the first `from` in a copied file, failing when the fixture no longer has it. */
export function edit(file: string, from: string, to: string): void {
  const text = fs.readFileSync(file, "utf-8");
  expect(text).toContain(from);
  fs.writeFileSync(file, text.replace(from, to));
}

/** Runs each command into one summaries folder and returns the missing-route findings. */
export async function missingRoutes(
  app: string,
  commands: SummaryCommand[],
): Promise<Finding[]> {
  const summaries = path.join(app, ".summaries");
  fs.mkdirSync(summaries, { recursive: true });
  const before = process.cwd();
  try {
    for (const [at, command] of commands.entries()) {
      process.chdir(command.cwd ?? app);
      expect(
        await quietly(command.argv(path.join(summaries, `${at}.json`))),
      ).toBe(0);
    }
  } finally {
    process.chdir(before);
  }
  const written = path.join(app, "check.json");
  await quietly([
    "check",
    "--dir",
    summaries,
    "--json",
    "--fail-on",
    "none",
    "--allow-empty",
    "-o",
    written,
  ]);
  const report = JSON.parse(fs.readFileSync(written, "utf-8")) as {
    findings: Finding[];
  };
  return report.findings.filter((f) => f.kind === "restMethodOnUnknownPath");
}

export function typescript(...packs: string[]) {
  return (out: string) => [
    "extract",
    "-p",
    "tsconfig.json",
    ...packs.flatMap((pack) => ["-f", pack]),
    "--no-cache",
    "-o",
    out,
  ];
}

export function python(...packs: string[]) {
  return (out: string) => [
    "extract",
    "--lang",
    "python",
    "--dir",
    ".",
    ...packs.flatMap((pack) => ["-f", pack]),
    "--no-cache",
    "-o",
    out,
  ];
}

export function contract(from: string, file: string) {
  return (out: string) => ["contract", "--from", from, file, "-o", out];
}
