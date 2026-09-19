/**
 * A `receives` block on a REST boundary, against the Express fixture
 * that declares one.
 *
 * Two routes, two ways a tenant header gets checked. One reads it in
 * the handler; the other never touches it, because the middleware
 * registered around it does. Both are quiet, which is the point: a
 * route whose middleware owns the header is not a route that ignores it.
 *
 * Renaming the read is what makes the pass speak, and until this landed
 * it said nothing, because the run had no way to tell a header read
 * from a query read.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runCli } from "./run.js";

import type { CheckIntentResult } from "@suss/checker-intent";

const repoRoot = path.resolve(__dirname, "../../..");
const fixture = path.join(repoRoot, "fixtures/express-tenant");

let root: string;
let code: string;

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

/** The intent pass over whatever the copy contains right now. */
async function checkIntent(): Promise<CheckIntentResult> {
  const summaries = path.join(root, "summaries");
  fs.rmSync(summaries, { recursive: true, force: true });
  fs.mkdirSync(summaries, { recursive: true });

  expect(
    await run([
      "extract",
      "--dir",
      code,
      "-f",
      "express",
      "-o",
      path.join(summaries, "code.json"),
    ]),
  ).toBe(0);

  const written = path.join(root, "check.json");
  await run([
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
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "suss-receives-rest-"));
  code = path.join(root, "app");
  fs.cpSync(fixture, code, { recursive: true });
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("a receives block on a REST boundary", () => {
  it("says nothing when the handler and the middleware read what is declared", async () => {
    const intent = await checkIntent();

    expect(intent.findings).toEqual([]);
    expect(intent.checked).toHaveLength(2);
  });

  it("reports both sides when the handler reads a header nobody declared", async () => {
    const handler = path.join(code, "handlerReads.ts");
    fs.writeFileSync(
      handler,
      fs.readFileSync(handler, "utf-8").replace("x-tenant-id", "x-tenant"),
    );

    const intent = await checkIntent();
    const said = intent.findings.map((f) => `${f.kind}: ${f.message}`);

    expect(said).toHaveLength(2);
    expect(said[0]).toContain("unreadInputField");
    expect(said[0]).toContain(
      "says GET /invoices/{id} receives headers.x-tenant-id and needs it; get never reads it",
    );
    expect(said[1]).toContain("undeclaredInputRead");
    expect(said[1]).toContain(
      "get reads headers.x-tenant off what it was handed at GET /invoices/{id}",
    );
  });
});
