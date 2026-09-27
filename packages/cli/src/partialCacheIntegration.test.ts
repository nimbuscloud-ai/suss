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
  written: string;
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
  const written = fs.readFileSync(out, "utf8");
  return {
    written,
    summaries: JSON.parse(written),
    cacheLine:
      result.stderr.split("\n").find((line) => line.includes("cache:")) ?? "",
  };
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
    expect(partial.written).toBe(fresh.written);
  });

  it("writes the summaries in a cold run's order after an edit to the first file", () => {
    configProject();
    extract("cold");

    // The reused summaries come from files after config.ts, so a merge
    // that put them first would write them before readPort.
    write("src/config.ts", [
      "export function readPort(): number {",
      "  if (process.env.PORT === undefined) {",
      "    return 3000;",
      "  }",
      "  return Number(process.env.PORT);",
      "}",
    ]);
    const partial = extract("partial");
    const fresh = extract("fresh", ["--no-cache"]);

    expect(partial.cacheLine).toContain("cache: partial");
    expect(partial.written).toBe(fresh.written);
  });

  it("follows an unchanged caller into what its edited callee now calls", () => {
    configProject();
    write("src/store.ts", [
      "export function loadOrders(): string[] {",
      "  return [];",
      "}",
    ]);
    write("src/report.ts", [
      'import { loadOrders } from "./store";',
      "",
      "export function orderReport(): number {",
      "  return loadOrders().length;",
      "}",
    ]);
    extract("cold");

    write("src/store.ts", [
      "function audit(): void {",
      '  console.log(process.env.AUDIT_LOG ?? "off");',
      "}",
      "",
      "export function loadOrders(): string[] {",
      "  audit();",
      "  return [];",
      "}",
    ]);
    const partial = extract("partial");
    const fresh = extract("fresh", ["--no-cache"]);

    expect(names(partial)).toContain("audit");
    expect(partial.written).toBe(fresh.written);
  });

  it("drops a deleted file's records from the cache", () => {
    configProject();
    write("src/audit.ts", [
      "export function audit(): string {",
      '  return process.env.AUDIT_LOG ?? "off";',
      "}",
    ]);
    write("src/report.ts", [
      'import { audit } from "./audit";',
      "",
      "export function orderReport(): string {",
      "  return audit();",
      "}",
    ]);
    extract("cold");
    expect(recordedFiles()).toContain(path.join(tmpDir, "src", "audit.ts"));

    fs.rmSync(path.join(tmpDir, "src", "audit.ts"));
    write("src/report.ts", [
      "export function orderReport(): string {",
      '  return "none";',
      "}",
    ]);
    const partial = extract("partial");
    const fresh = extract("fresh", ["--no-cache"]);

    expect(recordedFiles()).not.toContain(path.join(tmpDir, "src", "audit.ts"));
    expect(partial.written).toBe(fresh.written);
  });
});

function names(run: Run): string[] {
  return run.summaries.map(
    (summary) => (summary as { identity: { name: string } }).identity.name,
  );
}

/** The files the cache kept closure records for. */
function recordedFiles(): string[] {
  const cacheDir = path.join(tmpDir, ".suss", "cache");
  const files: string[] = [];
  for (const entry of fs.readdirSync(cacheDir)) {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(cacheDir, entry, "manifest.json"), "utf8"),
    ) as { depPaths?: string[]; units?: Array<{ file: number }> };
    for (const unit of manifest.units ?? []) {
      files.push(manifest.depPaths?.[unit.file] ?? "");
    }
  }
  return files;
}
