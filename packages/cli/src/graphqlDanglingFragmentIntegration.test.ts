// Dangling fragment spread, end to end through the built binary, on
// three fixture projects sharing the saleor-dashboard shape from #490.
// Each test name says which document ships and what the run reports.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const BIN = path.resolve(__dirname, "../dist/bin.js");
const FIXTURES_ROOT = path.resolve(__dirname, "../../../fixtures");

function checkFixture(fixture: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-dangling-"));
  const extract = spawnSync(
    process.execPath,
    [
      BIN,
      "extract",
      "--dir",
      path.join(FIXTURES_ROOT, "apollo-client", fixture),
      "-f",
      "apollo-client",
      "--no-cache",
      "-o",
      path.join(dir, "summaries.json"),
    ],
    { encoding: "utf8", timeout: 120_000 },
  );
  expect(extract.status, extract.stderr).toBe(0);
  return spawnSync(process.execPath, [BIN, "check", "--dir", dir, "--all"], {
    encoding: "utf8",
    timeout: 120_000,
  });
}

describe("dangling fragment spread through the built binary", () => {
  it("reports the shipped dangling spread as an error when no registry is configured", () => {
    const result = checkFixture("dangling-fragment");
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain("[ERROR] graphqlUnknownFragment");
    expect(result.stdout).toContain(
      'ships a document spreading "...Invoice" with no definition, and no fragment registry is configured, so the query throws `Unknown fragment: Invoice` when it runs.',
    );
  });

  it("keeps the info finding when the cache installs a fragment registry", () => {
    const result = checkFixture("registry-configured");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("graphqlUnknownFragment");
    expect(result.stdout).toContain("[INFO] lowConfidence");
    expect(result.stdout).toContain('spreads "...Invoice"');
  });

  it("reports nothing about fragments when the composed document is the one used", () => {
    const result = checkFixture("codegen-composed");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("graphqlUnknownFragment");
    expect(result.stdout).not.toContain('"...Invoice"');
  });
});
