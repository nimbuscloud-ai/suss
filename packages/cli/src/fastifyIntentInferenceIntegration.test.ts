/**
 * The brownfield journey over the Fastify fixture, in the order a person
 * meets it: extract the handlers, infer one intent doc per route, check
 * before curating, fill in the blanks, check again.
 *
 * The last step is the point. Inferred intent describes the code it was
 * read from, so a run against that code has nothing to report. A doc
 * this command writes that the checker then argues with is a defect in
 * the mapping, and this is what catches it.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runCli } from "./run.js";

import type { CheckIntentResult } from "@suss/checker-intent";

const repoRoot = path.resolve(__dirname, "../../..");
const fixture = path.join(repoRoot, "fixtures/fastify");

let root: string;
let summariesDir: string;
let intentDir: string;

/** Exit code plus what the command wrote, each stream on its own. */
async function run(
  argv: string[],
): Promise<{ exit: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string) => {
    out.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => {
    err.push(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    const exit = await runCli(argv);
    return { exit, stdout: out.join(""), stderr: err.join("") };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

/** Fill in the two blanks the draft leaves, the way a person would. */
function curate(file: string): void {
  const filled = fs
    .readFileSync(file, "utf-8")
    .replace(/^purpose: "".*$/m, "purpose: Look one user up by id.")
    .replace(/^audience: "".*$/m, "audience: web-client")
    .replace(/^source: inferred$/m, 'source: "inferred, curated"');
  fs.writeFileSync(file, filled);
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "suss-infer-journey-"));
  summariesDir = path.join(root, "summaries");
  intentDir = path.join(root, "intent");
  fs.mkdirSync(summariesDir, { recursive: true });

  const extracted = await run([
    "extract",
    "--dir",
    fixture,
    "-f",
    "fastify",
    "-o",
    path.join(summariesDir, "code.json"),
  ]);
  expect(extracted.exit).toBe(0);

  const inferred = await run([
    "infer",
    "intent",
    "--from",
    path.join(summariesDir, "code.json"),
    "--out",
    intentDir,
  ]);
  expect(inferred.exit).toBe(0);
}, 120_000);

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("extract, infer intent, check", () => {
  it("writes a doc for every route in the fixture", () => {
    expect(fs.readdirSync(intentDir).sort()).toEqual([
      "get-defaults.intent.yaml",
      "get-lookup-id.intent.yaml",
      "get-me.intent.yaml",
      "get-moved.intent.yaml",
      "get-old-profile.intent.yaml",
      "get-users-id.intent.yaml",
    ]);
  });

  it("names the outcomes of GET /users/:id after its status codes", () => {
    const doc = fs.readFileSync(
      path.join(intentDir, "get-users-id.intent.yaml"),
      "utf-8",
    );

    expect(doc).toContain("source: inferred");
    expect(doc).toContain('purpose: ""');
    expect(doc).toContain('audience: ""');
    expect(doc).toContain("id: 400-bad-request");
    expect(doc).toContain("id: 404-not-found");
    expect(doc).toContain("id: 200-ok");
    expect(doc).toContain("id: 200-ok-2");
  });

  it("says which drafts are still waiting on their blanks", async () => {
    const checked = await run([
      "check",
      "--dir",
      summariesDir,
      "--intent",
      intentDir,
    ]);

    expect(checked.exit).toBe(1);
    expect(checked.stderr).toContain(`6 intent doc(s) in ${intentDir}`);
    expect(checked.stderr).toContain(
      "are inferred drafts with blanks still in them",
    );
    expect(checked.stderr).toContain("get-users-id.intent.yaml");
    expect(checked.stderr).toContain('set source to "inferred, curated"');
  });

  it("pairs every curated doc against the code it was drafted from", async () => {
    for (const file of fs.readdirSync(intentDir)) {
      curate(path.join(intentDir, file));
    }

    const checked = await run([
      "check",
      "--dir",
      summariesDir,
      "--intent",
      intentDir,
      "--json",
      "--allow-empty",
    ]);

    expect(checked.exit).toBe(0);
    const intent = (JSON.parse(checked.stdout) as { intent: CheckIntentResult })
      .intent;
    expect(intent.findings).toEqual([]);
    expect(intent.unchecked).toEqual([]);
    expect(intent.checked).toHaveLength(6);
  });
});
