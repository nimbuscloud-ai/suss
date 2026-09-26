// A warm extract writes what the cold extract wrote, byte for byte, through
// the built binary. The binary loads the adapter from its bundle, so the
// on-disk cache is on here the way it is for a user.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const BIN = path.resolve(__dirname, "../dist/bin.js");

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-extract-cache-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(relPath: string, content: string): void {
  const full = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

/** A route behind middleware that can return 401 before the route runs. */
function wrappedRouteProject(): void {
  write("package.json", JSON.stringify({ name: "orders-api" }));
  write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: { strict: true, module: "esnext" },
      include: ["src"],
    }),
  );
  write(
    "src/requireCaller.ts",
    [
      "export const requireCaller = (req: any, res: any, next: any) => {",
      "  if (!req.headers.authorization) {",
      '    res.status(401).json({ error: "unauthorized" });',
      "    return;",
      "  }",
      "  next();",
      "};",
    ].join("\n"),
  );
  write(
    "src/app.ts",
    [
      'import express from "express";',
      'import { requireCaller } from "./requireCaller";',
      "",
      "const app = express();",
      "app.use(requireCaller);",
      'app.get("/orders", (req: any, res: any) => {',
      "  res.status(200).json({ orders: [] });",
      "});",
    ].join("\n"),
  );
}

/** Runs one extract and returns what it wrote and what it said about the cache. */
function extract(label: string): { written: string; cacheLine: string } {
  const out = path.join(tmpDir, "out", `${label}.json`);
  const result = spawnSync(
    process.execPath,
    [
      BIN,
      "extract",
      "-p",
      path.join(tmpDir, "tsconfig.json"),
      "-f",
      "express",
      "--timing",
      "-o",
      out,
    ],
    { encoding: "utf8", timeout: 120_000 },
  );
  expect(result.status, result.stderr).toBe(0);
  const cacheLine =
    result.stderr.split("\n").find((line) => line.includes("cache:")) ?? "";
  return { written: fs.readFileSync(out, "utf8"), cacheLine };
}

function ordersStatuses(written: string): unknown[] {
  const summaries = JSON.parse(written) as Array<{
    identity: { boundaryBinding?: { semantics?: { path?: string } } | null };
    transitions: Array<{
      output: { statusCode?: { type: string; value?: unknown } };
    }>;
  }>;
  const route = summaries.find(
    (one) => one.identity.boundaryBinding?.semantics?.path === "/orders",
  );
  return (route?.transitions ?? []).map(
    (transition) => transition.output.statusCode?.value,
  );
}

describe("the extraction cache through the built binary", () => {
  it("writes the cold run's output on a warm run over unchanged files", () => {
    wrappedRouteProject();

    const cold = extract("cold");
    const warm = extract("warm");

    expect(cold.cacheLine).toContain("cache: miss");
    expect(warm.cacheLine).toContain("cache: hit");
    // The route returns the middleware's 401 only once wrappers are
    // composed, so a hit that skipped composing would lose it.
    expect(ordersStatuses(cold.written)).toContain(401);
    expect(warm.written).toBe(cold.written);
  });

  it("writes the cold run's output after a touch that changed no content", () => {
    wrappedRouteProject();

    const cold = extract("cold");
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(path.join(tmpDir, "src", "app.ts"), later, later);
    const touched = extract("touched");

    expect(touched.cacheLine).toContain("cache: hit");
    expect(touched.written).toBe(cold.written);
  });
});
