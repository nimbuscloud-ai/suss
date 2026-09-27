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

/**
 * Two routes whose types the checker numbers differently depending on
 * which file it reads first. The audit file, read first on a cold run,
 * creates two of the order's status literals before the order file does.
 * A run that re-reads only the order file creates them in the order file's
 * order. The error class has a property keyed by a symbol, whose checker
 * name ends in a number that also moves with how much has been read.
 */
function typedRoutesProject(): void {
  write("package.json", JSON.stringify({ name: "orders-api" }));
  write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: { strict: true, target: "es2022", module: "esnext" },
      include: ["src"],
    }),
  );
  write(
    "src/audit.ts",
    [
      'import express from "express";',
      "",
      'export type AuditEntry = { outcome: "refunded" | "closed"; at: number };',
      "",
      "declare function lastAudit(): AuditEntry;",
      "",
      "const app = express();",
      'app.get("/audit", (req: any, res: any) => {',
      "  res.status(200).json(lastAudit());",
      "});",
    ].join("\n"),
  );
  write("src/orders.ts", ordersFile(""));
}

function ordersFile(trailer: string): string {
  return [
    'import express from "express";',
    "",
    "interface Order {",
    "  id: string;",
    '  status: "open" | "closed" | "refunded";',
    "}",
    "",
    'type OrderView = Pick<Order, "status" | "id">;',
    "",
    "class OrderError {",
    "  constructor(public code: string) {}",
    "  get [Symbol.toStringTag]() {",
    '    return "OrderError";',
    "  }",
    "}",
    "",
    "declare function loadOrder(id: string): Order;",
    "declare function viewOf(order: Order): OrderView;",
    "declare function failure(code: string): OrderError;",
    "",
    "const app = express();",
    'app.get("/orders/:id", (req: any, res: any) => {',
    "  if (!req.params.id) {",
    '    res.status(400).json(failure("missing"));',
    "    return;",
    "  }",
    "  res.status(200).json(viewOf(loadOrder(req.params.id)));",
    `});${trailer}`,
  ].join("\n");
}

/** Runs one extract and returns what it wrote and what it said about the cache. */
function extract(
  label: string,
  options: { noCache?: boolean } = {},
): { written: string; cacheLine: string } {
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
      ...(options.noCache === true ? ["--no-cache"] : []),
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

  it("writes the same bytes on two runs without the cache", () => {
    typedRoutesProject();

    const first = extract("first", { noCache: true });
    const second = extract("second", { noCache: true });

    expect(second.written).toBe(first.written);
    expect(first.written).toContain('"[Symbol.toStringTag]"');
    expect(first.written).not.toContain("__@");
  });

  it("writes what a run without the cache writes after re-reading one changed file", () => {
    typedRoutesProject();

    extract("cold");
    write("src/orders.ts", ordersFile(" // edited"));
    const warm = extract("warm");
    const fresh = extract("fresh", { noCache: true });

    expect(warm.cacheLine).toContain("cache: partial");
    expect(warm.written).toBe(fresh.written);
  });
});
