/**
 * A `from` on a results line, against the Express orders route that
 * scopes its query to the tenant in the caller's token.
 *
 * The route passes the token's tenant to the query, and the check is
 * quiet. A change that takes the tenant from the request body instead
 * is what the document exists to catch, and the check says which source
 * it found. A route that decodes the token with a function the run
 * cannot see gives the walk nothing to follow, so the claim goes
 * unchecked rather than wrong.
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
      "-f",
      "pg",
      "--no-cache",
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

/** The orders route with its tenant argument written some other way. */
function tenantFrom(written: string): void {
  const route = path.join(code, "ordersList.ts");
  fs.writeFileSync(
    route,
    fs
      .readFileSync(path.join(fixture, "ordersList.ts"), "utf-8")
      .replace("[req.auth.tenantId]", `[${written}]`),
  );
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "suss-tenant-source-"));
  code = path.join(root, "app");
  fs.cpSync(fixture, code, { recursive: true });
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("a results line that says where the tenant comes from", () => {
  it("is quiet while the query takes the tenant from the token", async () => {
    const intent = await checkIntent();

    expect(intent.findings).toEqual([]);
    expect(intent.unchecked).toEqual([]);
  }, 60_000);

  it("reports the query once it takes the tenant from the body", async () => {
    tenantFrom("req.body.tenantId");

    const intent = await checkIntent();

    expect(intent.findings).toHaveLength(1);
    expect(intent.findings[0]).toMatchObject({
      kind: "valueFromElsewhere",
      severity: "error",
      boundary: "GET /orders",
      intent: { name: "orders-list", outcomeId: "listed" },
    });
    expect(intent.findings[0].message).toContain(
      'Intent "orders-list" says listed reads postgresql:orders with tenant_id taken from input.auth.tenantId; get takes it from input.body.tenantId',
    );
  }, 60_000);

  it("leaves the claim unchecked when the walk stops at a call it cannot follow", async () => {
    tenantFrom("decodeTenant(req.headers.authorization)");

    const intent = await checkIntent();

    expect(intent.findings).toEqual([]);
    expect(intent.unchecked).toEqual([
      {
        intent: "orders-list",
        reason: "unreadValue",
        outcomeId: "listed",
        detail:
          "listed reads postgresql:orders with tenant_id taken from input.auth.tenantId: the walk from tenant_id stopped at `decodeTenant(req.headers.authorization)`, which it cannot follow.",
      },
    ]);
  }, 60_000);
});
