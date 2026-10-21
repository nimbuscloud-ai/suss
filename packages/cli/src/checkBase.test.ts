// `suss check --base` over the orders fixture, an Express route and a fetch
// client, committed to git. Each test edits the working tree the way a pull
// request would and asks what the edit introduced.

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { forgetBaseReads, readBase } from "./checkBase.js";
import { runCli } from "./run.js";

const FIXTURE = path.resolve(__dirname, "../../../fixtures/supervisor-orders");

// `test` depends on `build` in turbo.json, so dist/ is present here.
const BIN = path.resolve(__dirname, "../dist/bin.js");

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

const LINES_ABOVE_THE_ROUTE = {
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
let startedIn: string;

beforeEach(() => {
  startedIn = process.cwd();
  work = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "suss-base-test-")),
  );
  project = path.join(work, "orders-app");
  fs.cpSync(FIXTURE, project, {
    recursive: true,
    filter: (source) => !source.split(path.sep).includes(".suss"),
  });
  fs.writeFileSync(path.join(project, ".gitignore"), "node_modules\n.suss\n");
  git("init", "--quiet");
});

afterEach(() => {
  process.chdir(startedIn);
  fs.rmSync(work, { recursive: true, force: true });
});

function git(...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.email=suss@example.com",
      "-c",
      "user.name=suss",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd: project, encoding: "utf8" },
  );
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function commit(message: string): void {
  git("add", "-A");
  git("commit", "--quiet", "-m", message);
}

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
    process.chdir(project);
    const exit = await runCli(args);
    return { exit, stdout: out.join(""), stderr: err.join("") };
  } finally {
    process.stdout.write = writeOut;
    process.stderr.write = writeErr;
  }
}

/** `suss check` from the built binary in its own process, so two can run at once. */
function builtCheck(
  args: string[],
  cacheRoot: string,
): Promise<{ exit: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [BIN, "check", ...args], {
    cwd: project,
    env: { ...process.env, SUSS_CACHE_DIR: cacheRoot },
  });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
  return new Promise((resolve) => {
    child.on("close", (exit) =>
      resolve({
        exit,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      }),
    );
  });
}

async function againstBase(ref = "HEAD", extra: string[] = []) {
  const run = await quietly(["check", "--base", ref, "--json", ...extra]);
  return { exit: run.exit, report: JSON.parse(run.stdout) };
}

describe("check --base", () => {
  it("reports the finding an edit introduced, with the file and line on both sides", async () => {
    commit("base");
    edit(ADD_409);

    const { exit, report } = await againstBase();

    expect(exit).toBe(0);
    expect(report.base).toEqual({
      ref: "HEAD",
      commit: git("rev-parse", "HEAD").trim(),
      branchPoint: true,
    });
    expect(report.changedFiles).toEqual(["src/orders/create.ts"]);
    expect(report.findings).toHaveLength(1);
    const [finding] = report.findings;
    expect(finding.kind).toBe("unhandledProviderCase");
    expect(finding.touchedByChange).toEqual(["provider", "boundary"]);
    expect(finding.provider.location.file).toBe("src/orders/create.ts");
    expect(finding.consumer.location.file).toBe("web/orders/submitOrder.ts");
    expect(report.resolved).toEqual([]);
    expect(report.addedElsewhere).toEqual([]);
  });

  it("does not report a finding as new when lines were added above it", async () => {
    edit(ADD_409);
    commit("base with the 409");
    edit(LINES_ABOVE_THE_ROUTE);

    const { report } = await againstBase();

    expect(report.changedFiles).toEqual(["src/orders/create.ts"]);
    expect(report.findings).toEqual([]);
    expect(report.resolved).toEqual([]);
    expect(report.addedElsewhere).toEqual([]);
  });

  it("lists a finding the change fixed as resolved, in one line with both sides", async () => {
    edit(ADD_409);
    commit("base with the 409");
    edit(HANDLE_409);

    const run = await quietly(["check", "--base", "HEAD"]);

    expect(run.exit).toBe(0);
    expect(run.stdout).toContain("1 file changed:");
    expect(run.stdout).toContain("0 new findings, 1 resolved.");
    expect(run.stdout).toMatch(
      /^ {2}unhandledProviderCase at POST \/orders: Provider produces status 409 but no consumer branch handles it \(src\/orders\/create\.ts:\d+ and web\/orders\/submitOrder\.ts:\d+\)$/m,
    );
  });

  it("compares with the commit the branch left the ref at", async () => {
    commit("base");
    git("branch", "trunk");
    git("checkout", "--quiet", "-b", "feature");
    edit(ADD_409);
    commit("add a 409");
    git("checkout", "--quiet", "trunk");
    edit(HANDLE_409);
    commit("the trunk moved on");
    git("checkout", "--quiet", "feature");

    const { report } = await againstBase("trunk");

    expect(report.base.commit).toBe(
      git("merge-base", "trunk", "feature").trim(),
    );
    expect(report.changedFiles).toEqual(["src/orders/create.ts"]);
    expect(report.findings.map((f: { kind: string }) => f.kind)).toEqual([
      "unhandledProviderCase",
    ]);
  });

  it("counts an untracked file as changed, and leaves the checkout as it was", async () => {
    commit("base");
    fs.writeFileSync(
      path.join(project, "src", "orders", "notes.ts"),
      "export const NOTE = 1;\n",
    );
    const status = git("status", "--porcelain");
    const worktrees = git("worktree", "list");

    const { report } = await againstBase();

    expect(report.changedFiles).toEqual(["src/orders/notes.ts"]);
    expect(git("status", "--porcelain")).toBe(status);
    expect(git("worktree", "list")).toBe(worktrees);
  });

  it("gives a contract's units the path they have in the checkout", async () => {
    fs.mkdirSync(path.join(project, "prisma"));
    fs.writeFileSync(
      path.join(project, "prisma", "schema.prisma"),
      [
        'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}',
        "model Order {\n  id String @id\n  sku String\n  quantity Int\n}",
      ].join("\n\n"),
    );
    const config = JSON.parse(
      fs.readFileSync(path.join(project, "suss.json"), "utf8"),
    );
    fs.writeFileSync(
      path.join(project, "wrangler.jsonc"),
      JSON.stringify({
        name: "orders",
        main: "src/orders/create.ts",
        vars: { REGION: "eu" },
      }),
    );
    // Both readers write their file relative to the working directory.
    config.read.push(
      { kind: "contract", from: "prisma", file: "prisma/schema.prisma" },
      { kind: "contract", from: "wrangler", file: "wrangler.jsonc" },
    );
    fs.writeFileSync(path.join(project, "suss.json"), JSON.stringify(config));
    commit("base with a contract");
    edit(ADD_409);

    const { report } = await againstBase();

    const units = report.changedBoundaries.flatMap(
      (boundary: { units: string[] }) => boundary.units,
    );
    expect(units).toEqual(["src/orders/create.ts::post"]);
    expect(report.resolved).toEqual([]);
    expect(report.resolvedElsewhere).toEqual([]);
  });

  it("skips a read whose folder the base did not have", async () => {
    commit("base");
    fs.mkdirSync(path.join(project, "jobs"));
    fs.writeFileSync(
      path.join(project, "jobs", "sweep.ts"),
      'export async function sweep() {\n  await fetch("/orders");\n}\n',
    );
    const config = JSON.parse(
      fs.readFileSync(path.join(project, "suss.json"), "utf8"),
    );
    config.read.push({
      kind: "extract",
      language: "typescript",
      dir: "jobs",
      packs: ["fetch"],
    });
    fs.writeFileSync(path.join(project, "suss.json"), JSON.stringify(config));

    const run = await quietly(["check", "--base", "HEAD", "--json"]);

    expect(run.stderr).toContain("skipped, since jobs did not exist at HEAD");
    expect(JSON.parse(run.stdout).changedFiles).toEqual([
      "jobs/sweep.ts",
      "suss.json",
    ]);
  });

  it("compares with the ref itself when the two histories share no commit", async () => {
    commit("base");
    const branch = git("rev-parse", "--abbrev-ref", "HEAD").trim();
    git("checkout", "--quiet", "--orphan", "elsewhere");
    commit("unrelated");
    git("checkout", "--quiet", branch);

    const run = await quietly(["check", "--base", "elsewhere", "--json"]);

    expect(run.stderr).toContain(
      "git could not find where HEAD left elsewhere",
    );
    expect(JSON.parse(run.stdout).base).toEqual({
      ref: "elsewhere",
      commit: git("rev-parse", "elsewhere").trim(),
      branchPoint: false,
    });
  });

  it("reads the base for a caller whose working directory is outside the checkout", async () => {
    commit("base");
    edit(ADD_409);
    process.chdir(work);

    const base = await readBase(project, "HEAD");

    expect(base.changedFiles).toEqual(["src/orders/create.ts"]);
    expect(fs.readdirSync(base.summaryDir)).toEqual(["0-extract.json"]);
  });

  it("keeps one cache for a base commit when SUSS_CACHE_DIR moves the cache", async () => {
    commit("base");
    edit(ADD_409);
    const cacheRoot = path.join(work, "cache-root");
    const before = process.env.SUSS_CACHE_DIR;
    process.env.SUSS_CACHE_DIR = cacheRoot;
    try {
      await againstBase();
      const afterFirst = fs.readdirSync(path.join(cacheRoot, "cache")).sort();
      forgetBaseReads();
      const second = await againstBase();
      const afterSecond = fs.readdirSync(path.join(cacheRoot, "cache")).sort();

      // One folder for the working tree and one for the base commit.
      expect(afterFirst).toHaveLength(2);
      expect(afterSecond).toEqual(afterFirst);
      expect(second.report.findings).toHaveLength(1);
    } finally {
      restoreEnv("SUSS_CACHE_DIR", before);
    }
  });

  it("gives two processes reading one base at once the same findings", async () => {
    commit("base");
    edit(ADD_409);
    const cacheRoot = path.join(work, "cache-root");

    const [first, second] = await Promise.all([
      builtCheck(["--base", "HEAD", "--json"], cacheRoot),
      builtCheck(["--base", "HEAD", "--json"], cacheRoot),
    ]);

    expect(first.exit, first.stderr).toBe(0);
    expect(second.exit, second.stderr).toBe(0);
    const identities = (run: { stdout: string }) =>
      JSON.parse(run.stdout).findings.map(
        (f: { identity: string }) => f.identity,
      );
    expect(identities(first)).toHaveLength(1);
    expect(identities(second)).toEqual(identities(first));
    expect(fs.readdirSync(path.join(cacheRoot, "cache"))).toHaveLength(2);
  });

  it("reads a base once per process, and again when its folder is gone", async () => {
    commit("base");
    forgetBaseReads();

    const [first, alongside] = await Promise.all([
      readBase(project, "HEAD"),
      readBase(project, "HEAD"),
    ]);
    const again = await readBase(project, "HEAD");
    fs.rmSync(first.summaryDir, { recursive: true, force: true });
    const reread = await readBase(project, "HEAD");

    expect(alongside.summaryDir).toBe(first.summaryDir);
    expect(again.summaryDir).toBe(first.summaryDir);
    expect(reread.summaryDir).not.toBe(first.summaryDir);
    expect(fs.readdirSync(reread.summaryDir)).toEqual(["0-extract.json"]);
  });

  it("stops when a read fails at the base, since its units would all look new", async () => {
    fs.writeFileSync(path.join(project, "openapi.yaml"), "paths: [unclosed\n");
    const config = JSON.parse(
      fs.readFileSync(path.join(project, "suss.json"), "utf8"),
    );
    config.read.push({
      kind: "contract",
      from: "openapi",
      file: "openapi.yaml",
    });
    fs.writeFileSync(path.join(project, "suss.json"), JSON.stringify(config));
    commit("base with a broken spec");
    fs.writeFileSync(
      path.join(project, "openapi.yaml"),
      "openapi: 3.0.0\ninfo: { title: orders, version: '1' }\npaths: {}\n",
    );

    const run = await quietly(["check", "--base", "HEAD"]);

    expect(run.exit).toBe(1);
    expect(run.stderr).toContain(
      "Reading HEAD failed, and every unit those reads cover would look new",
    );
  });

  it("says when nothing in the project matched a pack", async () => {
    fs.writeFileSync(
      path.join(project, "suss.json"),
      JSON.stringify({ version: 1, read: [] }),
    );
    commit("base");

    const run = await quietly(["check", "--base", "HEAD"]);

    expect(run.exit).toBe(1);
    expect(run.stderr).toContain("so there is nothing to read at HEAD");
  });

  it("refuses --at, --intent and a pair of files, which do not cover one change", async () => {
    commit("base");

    const withAt = await quietly(["check", "--base", "HEAD", "--at", "src"]);
    const withIntent = await quietly([
      "check",
      "--base",
      "HEAD",
      "--intent",
      "intent",
    ]);
    const withFiles = await quietly([
      "check",
      "a.json",
      "b.json",
      "--base",
      "HEAD",
    ]);

    expect(withAt.stderr).toContain("cannot run together");
    expect(withIntent.stderr).toContain("--intent scores the code");
    expect(withFiles.stderr).toContain("they take --dir or no files at all");
  });

  it("does not fail on a finding the base already had", async () => {
    edit(ADD_409);
    commit("base with the 409");
    edit(LINES_ABOVE_THE_ROUTE);

    const { exit } = await againstBase("HEAD", ["--fail-on", "warning"]);

    expect(exit).toBe(0);
  });

  it("says what to fetch when git does not know the ref", async () => {
    commit("base");

    const run = await quietly(["check", "--base", "origin/nowhere"]);

    expect(run.exit).toBe(1);
    expect(run.stderr).toContain("git does not know origin/nowhere");
  });

  it("refuses --since and --changed-files, which it takes the place of", async () => {
    commit("base");

    const withSince = await quietly([
      "check",
      "--base",
      "HEAD",
      "--since",
      work,
    ]);
    const withList = await quietly([
      "check",
      "--base",
      "HEAD",
      "--changed-files",
      path.join(work, "changed.txt"),
    ]);

    expect(withSince.exit).toBe(1);
    expect(withSince.stderr).toContain("takes the place of --since");
    expect(withList.exit).toBe(1);
    expect(withList.stderr).toContain("takes the place of --changed-files");
  });

  it("says to compare two folders with --since outside a git repository", async () => {
    fs.rmSync(path.join(project, ".git"), { recursive: true, force: true });

    const run = await quietly(["check", "--base", "main"]);

    expect(run.exit).toBe(1);
    expect(run.stderr).toContain("is not inside a git repository");
  });
});
