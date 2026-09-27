/**
 * suss's own intent/ against one covering test it lists, read from this
 * repository. The scenario is covered while the test keeps its title,
 * and `check --intent` reports it missing once a copy of intent/ renames
 * it. Without this, a check that stopped reading coveredBy would still
 * pass `npm run check:self`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runCli } from "./run.js";

import type { CheckIntentResult } from "@suss/checker-intent";

const repoRoot = path.resolve(__dirname, "../../..");
const intentDir = path.join(repoRoot, "intent");
const PRD = "checkAnAgentsEdit.prd.yaml";
const SCENARIO = "a finding that was already there";
const TITLE = "splits the findings into new and gone, by identity";

let root: string;
let summaries: string;

async function run(argv: string[]): Promise<number> {
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

/** What check --intent says about the canary scenario, over one copy of intent/. */
async function findingsFor(intent: string): Promise<string[]> {
  const report = path.join(root, `${path.basename(intent)}.json`);
  await run([
    "check",
    "--dir",
    summaries,
    "--intent",
    intent,
    "--json",
    "--allow-empty",
    "-o",
    report,
  ]);
  const { intent: result } = JSON.parse(fs.readFileSync(report, "utf8")) as {
    intent: CheckIntentResult;
  };
  return result.findings
    .filter((finding) => finding.scenario?.title === SCENARIO)
    .map((finding) => finding.kind);
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "suss-self-canary-"));
  summaries = path.join(root, "summaries");
  fs.mkdirSync(summaries);
  const checker = path.join(repoRoot, "packages/checker");
  expect(
    await run([
      "extract",
      "-p",
      path.join(checker, "tsconfig.json"),
      "-f",
      "package-exports",
      "-f",
      "vitest",
      "--intent",
      intentDir,
      "--no-cache",
      "-o",
      path.join(summaries, "checker.json"),
      "--files",
      path.join(checker, "src/index.ts"),
      path.join(checker, "src/since/changesSince.ts"),
      path.join(checker, "src/since/changesSince.test.ts"),
    ]),
  ).toBe(0);
}, 120_000);

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("suss's own intent/, with one covering test renamed", () => {
  it("still lists the test the canary renames", () => {
    expect(fs.readFileSync(path.join(intentDir, PRD), "utf8")).toContain(TITLE);
  });

  it("covers the scenario while the test keeps its title", async () => {
    expect(await findingsFor(intentDir)).toEqual([]);
  });

  it("reports the covering test missing once a copy renames it", async () => {
    const copy = path.join(root, "renamed");
    fs.cpSync(intentDir, copy, { recursive: true });
    const prd = path.join(copy, PRD);
    fs.writeFileSync(
      prd,
      fs.readFileSync(prd, "utf8").replace(TITLE, `${TITLE}, renamed`),
    );

    expect(await findingsFor(copy)).toEqual(["missingCoveringTest"]);
  });
});
