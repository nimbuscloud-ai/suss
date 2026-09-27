/**
 * A copy of a tenant fixture that a test can rewrite, extract and check
 * against the fixture's intent documents, the way a user runs the two
 * commands. Each language's tenant test drives one of these, so the
 * tests differ only in the fixture and the line they rewrite.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect } from "vitest";

import { runCli } from "../run.js";

import type { CheckIntentResult } from "@suss/checker-intent";

const repoRoot = path.resolve(__dirname, "../../../..");

export interface TenantProject {
  /** Extract the copy as it is now, then check it against its intent. */
  checkIntent(): Promise<CheckIntentResult>;
  /** Write the copy's route with `written` wherever the fixture wrote `original`. */
  rewrite(original: string, written: string): void;
  /** Delete the copy. */
  remove(): void;
}

export interface TenantFixture {
  /** The fixture's directory, relative to the repository root. */
  fixture: string;
  /** The route file, relative to the fixture. */
  route: string;
  /** The language to read, when it is not TypeScript. */
  language?: string;
  /** The packs to run, each with the fixture's config file for it when it takes one. */
  packs: ReadonlyArray<{ name: string; config?: string }>;
}

export function tenantProject(options: TenantFixture): TenantProject {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suss-tenant-source-"));
  const code = path.join(root, "app");
  const fixture = path.join(repoRoot, options.fixture);
  fs.cpSync(fixture, code, { recursive: true });
  const packArgs = options.packs.flatMap(({ name, config }) => [
    "-f",
    config === undefined ? name : `${name}=${path.join(code, config)}`,
  ]);

  return {
    async checkIntent() {
      const summaries = path.join(root, "summaries");
      fs.rmSync(summaries, { recursive: true, force: true });
      fs.mkdirSync(summaries, { recursive: true });
      const extracted = await quietly([
        "extract",
        "--dir",
        code,
        ...(options.language === undefined ? [] : ["--lang", options.language]),
        ...packArgs,
        "--no-cache",
        "-o",
        path.join(summaries, "code.json"),
      ]);
      expect(extracted).toBe(0);

      const written = path.join(root, "check.json");
      await quietly([
        "check",
        "--dir",
        summaries,
        "--intent",
        path.join(code, "intent"),
        "--json",
        "--allow-empty",
        "-o",
        written,
      ]);
      const report = JSON.parse(fs.readFileSync(written, "utf-8")) as {
        intent: CheckIntentResult;
      };
      return report.intent;
    },
    rewrite(original, written) {
      const source = fs.readFileSync(
        path.join(fixture, options.route),
        "utf-8",
      );
      expect(source).toContain(original);
      fs.writeFileSync(
        path.join(code, options.route),
        source.replace(original, written),
      );
    },
    remove() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Run the CLI without its output landing in the test log. */
async function quietly(argv: string[]): Promise<number> {
  const swallow = (() => true) as typeof process.stdout.write;
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = swallow;
  process.stderr.write = swallow;
  try {
    return await runCli(argv);
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}
