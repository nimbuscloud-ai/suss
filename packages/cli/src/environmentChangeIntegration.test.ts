/**
 * A Lambda service behind a SAM template, read with `extract --out-dir`
 * before and after a change that gives it a new environment variable.
 * Both functions build their service once per cold start, in a helper
 * they share, so no request reaches the read through a call. Each test
 * checks that a command says what changed in terms a developer can act
 * on.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runCli } from "./run.js";

const FIXTURE = path.resolve(
  __dirname,
  "../../../fixtures/supervisor-accounts",
);

let work: string;
let project: string;
const snapshots = { before: "", read: "", declared: "" };

beforeAll(async () => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "suss-environment-"));
  project = path.join(work, "accounts-service");
  fs.cpSync(FIXTURE, project, { recursive: true });

  snapshots.before = await snapshot("before");
  edit(
    "src/composition.ts",
    '    table: process.env.ACCOUNTS_TABLE ?? "accounts",\n',
    '    table: process.env.ACCOUNTS_TABLE ?? "accounts",\n    region: process.env.ACCOUNTS_REGION,\n',
  );
  snapshots.read = await snapshot("read");
  edit(
    "template.yaml",
    "Globals:",
    'Parameters:\n  AccountsRegion:\n    Type: String\n    Default: ""\n\nGlobals:',
  );
  for (const event of ["Get", "Update"]) {
    edit(
      "template.yaml",
      `          ACCOUNTS_TABLE: accounts\n      Events:\n        ${event}:`,
      `          ACCOUNTS_TABLE: accounts\n          ACCOUNTS_REGION: !Ref AccountsRegion\n      Events:\n        ${event}:`,
    );
  }
  snapshots.declared = await snapshot("declared");
});

afterAll(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

function edit(file: string, from: string, to: string): void {
  const at = path.join(project, file);
  const text = fs.readFileSync(at, "utf8");
  expect(text).toContain(from);
  fs.writeFileSync(at, text.replace(from, to));
}

async function quietly(
  args: string[],
  cwd = process.cwd(),
): Promise<{ exit: number; stdout: string }> {
  const out: string[] = [];
  const writeOut = process.stdout.write.bind(process.stdout);
  const writeErr = process.stderr.write.bind(process.stderr);
  const origCwd = process.cwd();
  process.stdout.write = ((chunk: string) => {
    out.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  process.chdir(cwd);
  try {
    const exit = await runCli(args);
    return { exit, stdout: out.join("") };
  } finally {
    process.chdir(origCwd);
    process.stdout.write = writeOut;
    process.stderr.write = writeErr;
  }
}

// The template's summaries are labelled by its path from the working
// directory, as they are when the plugin runs suss in the project.
async function snapshot(name: string): Promise<string> {
  const dir = path.join(work, name);
  const run = await quietly(["extract", "--out-dir", dir], project);
  expect(run.exit).toBe(0);
  return dir;
}

describe("check --since after a helper starts reading a variable", () => {
  it("labels the environment by the variable, with no package name, and leaves the helper unlabelled", async () => {
    const run = await quietly([
      "check",
      "--dir",
      snapshots.read,
      "--since",
      snapshots.before,
      "--json",
    ]);
    const report = JSON.parse(run.stdout);

    expect(report.changedBoundaries).toEqual([
      {
        key: "function-call:reachable",
        label: null,
        units: ["src/composition.ts::getAccountService"],
      },
      {
        key: "runtime-config:@suss/runtime-node",
        label: "runtime-config ACCOUNTS_REGION",
        units: ["src/composition.ts::getAccountService"],
      },
    ]);
  });

  it("labels each function whose template entry now declares the variable", async () => {
    const run = await quietly([
      "check",
      "--dir",
      snapshots.declared,
      "--since",
      snapshots.read,
      "--json",
    ]);
    const report = JSON.parse(run.stdout);

    expect(
      report.changedBoundaries.map((b: { label: string }) => b.label),
    ).toEqual([
      "runtime-config:GetAccountFunction ACCOUNTS_REGION",
      "runtime-config:UpdateAccountFunction ACCOUNTS_REGION",
    ]);
  });
});
