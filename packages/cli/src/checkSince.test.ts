// `suss extract --out-dir` and `suss check --since` over the orders
// fixture: an Express route and a fetch client in one project. Each test
// works on its own copy, and edits it the way an agent would.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCli } from "./run.js";

const FIXTURE = path.resolve(__dirname, "../../../fixtures/supervisor-orders");

const ADD_409 = {
  file: "src/orders/create.ts",
  from: "  const created = await orders.insert({ sku, quantity });",
  to: [
    "  const open = await orders.findOpen(sku);",
    "  if (open) {",
    '    res.status(409).json({ error: "an open order for this sku exists" });',
    "    return;",
    "  }",
    "  const created = await orders.insert({ sku, quantity });",
  ].join("\n"),
};

const HELPER_ABOVE_THE_ROUTE = {
  file: "src/orders/create.ts",
  from: "export const ordersRouter = Router();",
  to: [
    "// Orders are keyed by sku, and a sku has at most one open order.",
    "export function describeOrder(order: { sku: string; quantity: number }) {",
    '  return order.quantity + " x " + order.sku;',
    "}",
    "",
    "export const ordersRouter = Router();",
  ].join("\n"),
};

const HANDLE_409 = {
  file: "web/orders/submitOrder.ts",
  from: "  if (res.status === 400) {",
  to: [
    "  if (res.status === 409) {",
    '    throw new Error("an open order for this sku already exists");',
    "  }",
    "  if (res.status === 400) {",
  ].join("\n"),
};

let work: string;
let project: string;

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "suss-since-"));
  project = path.join(work, "orders-app");
  fs.cpSync(FIXTURE, project, {
    recursive: true,
    filter: (source) => !source.split(path.sep).includes(".suss"),
  });
});

afterEach(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

function edit(change: { file: string; from: string; to: string }): void {
  const file = path.join(project, change.file);
  const before = fs.readFileSync(file, "utf8");
  expect(before).toContain(change.from);
  fs.writeFileSync(file, before.replace(change.from, change.to));
}

async function quietly(
  args: string[],
): Promise<{ exit: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const writeOut = process.stdout.write.bind(process.stdout);
  const writeErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string) => {
    out.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => {
    err.push(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    const exit = await runCli(args);
    return { exit, stdout: out.join(""), stderr: err.join("") };
  } finally {
    process.stdout.write = writeOut;
    process.stderr.write = writeErr;
  }
}

async function snapshot(name: string): Promise<string> {
  const dir = path.join(work, name);
  const run = await quietly(["extract", "--out-dir", dir, "--dir", project]);
  expect(run.exit).toBe(0);
  return dir;
}

async function since(after: string, before: string, extra: string[] = []) {
  const run = await quietly([
    "check",
    "--dir",
    after,
    "--since",
    before,
    "--json",
    ...extra,
  ]);
  return { exit: run.exit, report: JSON.parse(run.stdout) };
}

describe("extract --out-dir", () => {
  it("writes each read suss.json lists to its own file", async () => {
    const dir = await snapshot("before");

    expect(fs.readdirSync(dir)).toEqual(["0-extract.json"]);
    const summaries = JSON.parse(
      fs.readFileSync(path.join(dir, "0-extract.json"), "utf8"),
    );
    expect(
      summaries
        .map((s: { identity: { name: string } }) => s.identity.name)
        .sort(),
    ).toEqual(["post", "submitOrder"]);
  });

  it("replaces what an earlier run wrote there", async () => {
    const dir = path.join(work, "reused");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "3-contract.json"), "[]");
    fs.writeFileSync(path.join(dir, "notes.txt"), "kept");

    await quietly(["extract", "--out-dir", dir, "--dir", project]);

    expect(fs.readdirSync(dir).sort()).toEqual(["0-extract.json", "notes.txt"]);
  });

  it("refuses the flags that pick one set of packs", async () => {
    const run = await quietly([
      "extract",
      "--out-dir",
      path.join(work, "x"),
      "-f",
      "express",
    ]);

    expect(run.exit).toBe(1);
    expect(run.stderr).toContain("--out-dir runs every read suss.json lists");
  });
});

describe("check --since", () => {
  it("reports the finding an edit introduced, at the boundary it changed", async () => {
    const before = await snapshot("before");
    edit(ADD_409);
    const after = await snapshot("after");

    const { exit, report } = await since(after, before);

    expect(exit).toBe(0);
    expect(report.since).toBe(before);
    expect(report.changedBoundaries).toEqual([
      {
        key: "POST /orders",
        units: ["src/orders/create.ts::post"],
      },
    ]);
    expect(report.resolved).toEqual([]);
    expect(report.findings).toHaveLength(1);
    const [finding] = report.findings;
    expect(finding.kind).toBe("unhandledProviderCase");
    expect(finding.boundaryKey).toBe("POST /orders");
    expect(finding.atChangedBoundary).toBe(true);
    expect(finding.rule).toEqual({
      kind: "unhandledProviderCase",
      boundary: "POST /orders",
      provider: { transitionId: finding.provider.transitionId },
    });
    expect(JSON.parse(finding.identity)).toEqual([
      "unhandledProviderCase",
      "POST /orders",
      "src/orders/create.ts::post",
      finding.provider.transitionId,
      "web/orders/submitOrder.ts::submitOrder",
      null,
      "Provider produces status 409 but no consumer branch handles it",
    ]);
  });

  it("sees nothing new when an edit above the route moves its lines", async () => {
    edit(ADD_409);
    const before = await snapshot("before");
    edit(HELPER_ABOVE_THE_ROUTE);
    const after = await snapshot("after");

    const { report } = await since(after, before);

    expect(report.findings).toEqual([]);
    expect(report.resolved).toEqual([]);
    expect(report.changedBoundaries).toEqual([]);
  });

  it("lists a finding the client fixed as resolved", async () => {
    edit(ADD_409);
    const before = await snapshot("before");
    edit(HANDLE_409);
    const after = await snapshot("after");

    const { report } = await since(after, before);

    expect(report.findings).toEqual([]);
    expect(report.resolved.map((f: { kind: string }) => f.kind)).toEqual([
      "unhandledProviderCase",
    ]);
    expect(report.changedBoundaries.map((b: { key: string }) => b.key)).toEqual(
      ["POST /orders"],
    );
  });

  it("fails only on findings new since the earlier run", async () => {
    edit(ADD_409);
    const withFinding = await snapshot("with-finding");
    edit(HELPER_ABOVE_THE_ROUTE);
    const unchanged = await snapshot("unchanged");

    const notNew = await since(unchanged, withFinding, [
      "--fail-on",
      "warning",
    ]);
    const plain = await quietly([
      "check",
      "--dir",
      unchanged,
      "--fail-on",
      "warning",
    ]);

    expect(notNew.exit).toBe(0);
    expect(plain.exit).toBe(1);
  });

  it("prints what changed in place of the full list of findings", async () => {
    const before = await snapshot("before");
    edit(ADD_409);
    const after = await snapshot("after");

    const run = await quietly(["check", "--dir", after, "--since", before]);

    expect(run.stdout).toContain(`Since ${before}:`);
    expect(run.stdout).toContain("1 boundary changed: POST /orders");
    expect(run.stdout).toContain("1 new finding, 0 resolved.");
  });

  it("refuses --at and a pair of files, which do not cover a whole run", async () => {
    const dir = await snapshot("before");

    const withAt = await quietly([
      "check",
      "--dir",
      dir,
      "--since",
      dir,
      "--at",
      "src/orders/create.ts",
    ]);
    const withFiles = await quietly([
      "check",
      path.join(dir, "0-extract.json"),
      path.join(dir, "0-extract.json"),
      "--since",
      dir,
    ]);

    expect(withAt.exit).toBe(1);
    expect(withAt.stderr).toContain("--since");
    expect(withFiles.exit).toBe(1);
    expect(withFiles.stderr).toContain("--since compares a folder");
  });

  it("refuses --intent, which scores a whole run against documents", async () => {
    const dir = await snapshot("before");

    const withIntent = await quietly([
      "check",
      "--dir",
      dir,
      "--since",
      dir,
      "--intent",
      path.join(work, "intent"),
    ]);

    expect(withIntent.exit).toBe(1);
    expect(withIntent.stderr).toContain("cannot run together");
  });
});
