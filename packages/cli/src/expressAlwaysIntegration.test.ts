/**
 * An `always` block on two Express admin routes, each of which should
 * write an audit row on every outcome past the admin check.
 *
 * The suspend route does. The delete route skips the audit write when
 * the user is not found, and the check reports that one transition,
 * with the outcome it produces and its line. Writing the row on that
 * branch makes the check quiet.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runCli } from "./run.js";

import type { CheckIntentResult } from "@suss/checker-intent";

const repoRoot = path.resolve(__dirname, "../../..");
const fixture = path.join(repoRoot, "fixtures/express-admin-audit");

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
      "-p",
      path.join(code, "tsconfig.json"),
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

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "suss-always-"));
  code = path.join(root, "app");
  fs.cpSync(fixture, code, { recursive: true });
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("an always block on Express admin routes", () => {
  it("reports the delete route's 404 branch, which skips the audit write", async () => {
    const intent = await checkIntent();

    expect(intent.checked).toHaveLength(2);
    expect(intent.findings).toHaveLength(1);
    expect(intent.findings[0]).toMatchObject({
      kind: "pathWithoutEffect",
      severity: "error",
      boundary: "DELETE /admin/users/{id}",
      intent: { name: "admin-users-delete", outcomeId: "not-found" },
    });
    expect(intent.findings[0].message).toContain(
      "the transition of delete at line 22, which produces not-found (status 404), does not",
    );
  }, 60_000);

  it("goes quiet once that branch writes the row", async () => {
    const routes = path.join(code, "src", "adminUsers.ts");
    fs.writeFileSync(
      routes,
      fs
        .readFileSync(routes, "utf-8")
        .replace(
          'res.status(404).json({ error: "no such user" });\n    return;\n  }\n\n  await pool.query("DELETE',
          'await pool.query(\n      "INSERT INTO audit_log (actor_id, action) VALUES ($1, $2)",\n      [actor, "delete-missing-user"],\n    );\n    res.status(404).json({ error: "no such user" });\n    return;\n  }\n\n  await pool.query("DELETE',
        ),
    );

    const intent = await checkIntent();

    expect(intent.findings).toEqual([]);
  }, 60_000);
});
