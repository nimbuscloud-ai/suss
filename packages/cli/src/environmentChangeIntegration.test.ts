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

const PROMPT =
  "Make the accounts table's region configurable through a new environment variable, ACCOUNTS_REGION. Keep today's behavior when it is unset.";

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
  fs.writeFileSync(
    path.join(work, "prompts.jsonl"),
    `${JSON.stringify({ prompt: PROMPT })}\n`,
  );
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

async function changeList(yaml: string) {
  const file = path.join(work, "changes.yaml");
  fs.writeFileSync(file, yaml);
  const run = await quietly([
    "intent",
    "check",
    file,
    "--before",
    snapshots.before,
    "--after",
    snapshots.declared,
    "--prompts",
    path.join(work, "prompts.jsonl"),
  ]);
  return run.stdout;
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

describe("inspect --diff over the two folders", () => {
  it("lists each function's new declaration and its code's new read", async () => {
    const run = await quietly([
      "inspect",
      "--diff",
      snapshots.before,
      snapshots.declared,
    ]);

    for (const fn of ["GetAccountFunction", "UpdateAccountFunction"]) {
      expect(run.stdout).toContain(
        [
          `~ serves runtime-config:${fn}  cloudformation:template.yaml::${fn}  (2 effects)`,
          "  effects",
          "    + declares ACCOUNTS_REGION from AccountsRegion",
          `    + reads runtime-config:${fn} ACCOUNTS_REGION  through getAccountService`,
        ].join("\n"),
      );
    }
  });
});

describe("intent check against a change to the environment", () => {
  it("lists the changed environments when no entry can be checked", async () => {
    const said = await changeList(
      [
        `asked: "${PROMPT}"`,
        "changes:",
        "  - changes: AccountService",
        "    note: takes an optional region",
      ].join("\n"),
    );

    expect(said).toContain(
      "1 unchecked and 2 boundaries changed where nobody asked.",
    );
    expect(said).toContain(
      "serves runtime-config:GetAccountFunction  cloudformation:template.yaml::GetAccountFunction",
    );
    expect(said).toContain("+ declares ACCOUNTS_REGION from AccountsRegion");
  });

  it("counts a read written as an effect on runtime-config done, for every function whose code reads it", async () => {
    const said = await changeList(
      [
        `asked: "${PROMPT}"`,
        "changes:",
        "  - adds: { reads: runtime-config, fields: [ACCOUNTS_REGION] }",
      ].join("\n"),
    );

    expect(said).toBe(
      [
        "1 done.",
        "",
        "done        + reads runtime-config [ACCOUNTS_REGION]  cloudformation:template.yaml::GetAccountFunction, cloudformation:template.yaml::UpdateAccountFunction",
        "",
      ].join("\n"),
    );
  });

  it("does not count a read of another variable", async () => {
    const said = await changeList(
      [
        `asked: "${PROMPT}"`,
        "changes:",
        "  - adds: { reads: runtime-config, fields: [ACCOUNTS_TABLE] }",
      ].join("\n"),
    );

    expect(said).toContain(
      "not done    + reads runtime-config [ACCOUNTS_TABLE]",
    );
    expect(said).toContain("2 boundaries changed where nobody asked");
  });
});

describe("check over what extract --out-dir wrote", () => {
  it("knows the template was read, and does not call the template and its own code two services", async () => {
    const run = await quietly(["check", "--dir", snapshots.declared], project);

    expect(run.stdout).not.toContain("was not read");
    expect(run.stdout).not.toContain("claimed by more than one file");
  });

  it("knows a template read into a file of its own with suss contract", async () => {
    const dir = path.join(work, "by-hand");
    fs.mkdirSync(dir);
    fs.copyFileSync(
      path.join(snapshots.declared, "0-extract.json"),
      path.join(dir, "code.json"),
    );
    await quietly(
      [
        "contract",
        "--from",
        "cloudformation",
        "template.yaml",
        "-o",
        path.join(dir, "cloudformation.json"),
      ],
      project,
    );

    const run = await quietly(["check", "--dir", dir], project);

    expect(run.stdout).not.toContain("was not read");
    expect(run.stdout).not.toContain("claimed by more than one file");
  });
});
