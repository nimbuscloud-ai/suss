// distBin.test.ts: run the built binary the way an npm user gets it.
//
// Every other test in this package imports TypeScript sources, so a
// dependency that only breaks once tsup has bundled it stays invisible.
// That happened: `ts-morph` was imported but never declared, so tsup
// treated it as bundleable and inlined a CommonJS package into an ESM
// bundle. `suss --help` then died on `Dynamic require of "fs"` while
// every source-level test stayed green.
//
// `test` depends on `build` in turbo.json, so dist/ is present here.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const BIN = path.resolve(__dirname, "../dist/bin.js");
const FIXTURES_ROOT = path.resolve(__dirname, "../../../fixtures");

function runBin(args: string[]) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    timeout: 120_000,
  });
}

describe("the built binary", () => {
  it("is executable and carries a node shebang", () => {
    const firstLine = fs.readFileSync(BIN, "utf8").split("\n", 1)[0];
    expect(firstLine).toBe("#!/usr/bin/env node");
  });

  it("prints usage under plain node", () => {
    const result = runBin(["--help"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("suss extract");
  });

  // --help only loads what the argument parser touches. Extract pulls in
  // the adapter and ts-morph, which is where the bundling bug lived.
  it("extracts a fixture end to end", () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-dist-bin-"));
    const outFile = path.join(outDir, "summaries.json");

    const result = runBin([
      "extract",
      "--dir",
      path.join(FIXTURES_ROOT, "express"),
      "-f",
      "express",
      "-o",
      outFile,
    ]);

    // Progress goes to stderr, so only the exit code says whether it ran.
    expect(result.status, result.stderr).toBe(0);

    const summaries = JSON.parse(fs.readFileSync(outFile, "utf8"));
    expect(Array.isArray(summaries.summaries ?? summaries)).toBe(true);

    fs.rmSync(outDir, { recursive: true, force: true });
  }, 120_000);
});
