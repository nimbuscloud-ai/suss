/**
 * A partial run after an edit, through the built binary, writes what a
 * run without the cache writes over the same tree, and reuses what the
 * edit could not have changed. The binary loads the adapter from its
 * bundle, so the on-disk cache is on here the way it is for a user.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const BIN = path.resolve(__dirname, "../dist/bin.js");

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-partial-cache-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(relPath: string, lines: string[]): void {
  const full = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, `${lines.join("\n")}\n`);
}

/**
 * Exported functions and no discovery pack, so every function is a root
 * the node pack contributes rather than a unit a pack discovered.
 */
function configProject(): void {
  write("package.json", [JSON.stringify({ name: "orders-config" })]);
  write("tsconfig.json", [
    JSON.stringify({
      compilerOptions: { strict: true, module: "esnext" },
      include: ["src"],
    }),
  ]);
  write("src/config.ts", [
    "export function readPort(): number {",
    '  return Number(process.env.PORT ?? "3000");',
    "}",
  ]);
  write("src/orders.ts", [
    'import { readPort } from "./config";',
    "",
    "export function ordersUrl(): string {",
    '  return "http://localhost:" + String(readPort()) + "/orders";',
    "}",
  ]);
  write("src/totals.ts", [
    "export function formatTotal(cents: number): string {",
    "  return (cents / 100).toFixed(2);",
    "}",
  ]);
}

interface Run {
  summaries: Array<{ identity: { id?: string } }>;
  cacheLine: string;
}

function extract(label: string, extra: string[] = []): Run {
  const out = path.join(tmpDir, "out", `${label}.json`);
  const result = spawnSync(
    process.execPath,
    [
      BIN,
      "extract",
      "-p",
      path.join(tmpDir, "tsconfig.json"),
      "-f",
      "node",
      "--timing",
      ...extra,
      "-o",
      out,
    ],
    { encoding: "utf8", timeout: 120_000 },
  );
  expect(result.status, result.stderr).toBe(0);
  return {
    summaries: JSON.parse(fs.readFileSync(out, "utf8")),
    cacheLine:
      result.stderr.split("\n").find((line) => line.includes("cache:")) ?? "",
  };
}

/** Each summary's JSON, sorted, since a partial run writes reused ones first. */
function contents(run: Run): string[] {
  return run.summaries.map((summary) => JSON.stringify(summary)).sort();
}

describe("a partial run of the extraction cache", () => {
  it("reuses what a recognizer-only pack's exports reach after an edit elsewhere", () => {
    configProject();
    extract("cold");

    write("src/totals.ts", [
      "export function formatTotal(cents: number): string {",
      "  if (cents < 0) {",
      '    throw new Error("negative total");',
      "  }",
      "  return (cents / 100).toFixed(2);",
      "}",
    ]);
    const partial = extract("partial");
    const fresh = extract("fresh", ["--no-cache"]);

    // readPort and ordersUrl belong to files the edit left alone.
    expect(partial.cacheLine).toContain("2 summaries reused");
    expect(contents(partial)).toEqual(contents(fresh));
  });
});
