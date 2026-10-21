/**
 * `check:self` compares the exit codes `intent/cli-check.intent.yaml` and
 * `intent/cli-init.intent.yaml` declare with what `runCheck` and
 * `initInteractive` return. suss links a return to the exit code only by
 * following calls from `bin.ts` down to the command, so the comparison
 * breaks if `dispatch` stops calling each command by name.
 *
 * The test copies the CLI's sources, rewrites the copy's `dispatch` so it
 * looks the command up in a `COMMANDS` record, reads the copy with the
 * packs the dogfood run uses, and checks the two documents against it.
 * run.ts itself keeps its `if` chain.
 */

import fs from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";
import { readProcessMetadata } from "@suss/behavioral-ir";
import { checkIntentAgreement } from "@suss/checker-intent";
import { loadIntentFile } from "@suss/contract-intent";
import { nodeRuntimePack } from "@suss/runtime-node";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { PatternPack } from "@suss/extractor";

const cliRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(cliRoot, "../..");

/** One branch of the `if` chain: `if (command === "check") { return await runCheck(rest); }`. */
const COMMAND_BRANCH =
  /\n {2}if \(command === "([a-z-]+)"\) \{\n {4}return (?:await )?(\w+)\(rest\);\n {2}\}/g;

/** Turns the copy's `if` chain into a lookup in a record built from it. */
function dispatchThroughATable(source: string): string {
  const entries = [...source.matchAll(COMMAND_BRANCH)].map(
    ([, command, run]) => `  ${JSON.stringify(command)}: ${run},`,
  );
  const first = source.search(COMMAND_BRANCH);
  const branches = source.match(COMMAND_BRANCH) ?? [];
  const last = branches.at(-1);
  if (first === -1 || last === undefined) {
    return source;
  }
  const end = source.lastIndexOf(last) + last.length;
  const lookup = [
    "",
    "  const run = command === undefined ? undefined : COMMANDS[command];",
    "  if (run !== undefined) {",
    "    return await run(rest);",
    "  }",
  ].join("\n");
  const table = [
    "",
    "const COMMANDS: Record<string, (args: string[]) => number | Promise<number>> = {",
    ...entries,
    "};",
    "",
  ].join("\n");
  return `${source.slice(0, first)}${lookup}${source.slice(end)}${table}`;
}

let copy: string;

beforeAll(() => {
  // Inside the package, so the copy resolves @suss/* the way the package
  // does. Every `.suss` folder is gitignored.
  const parent = path.join(cliRoot, ".suss");
  fs.mkdirSync(parent, { recursive: true });
  copy = fs.mkdtempSync(path.join(parent, "dispatch-table-"));
  fs.mkdirSync(path.join(copy, "src"));
  for (const file of fs.readdirSync(path.join(cliRoot, "src"))) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) {
      continue;
    }

    fs.copyFileSync(
      path.join(cliRoot, "src", file),
      path.join(copy, "src", file),
    );
  }
  fs.copyFileSync(
    path.join(cliRoot, "package.json"),
    path.join(copy, "package.json"),
  );
  fs.writeFileSync(
    path.join(copy, "tsconfig.json"),
    JSON.stringify({
      extends: path.join(repoRoot, "tsconfig.base.json"),
      compilerOptions: { outDir: "./dist", rootDir: "./src" },
      include: ["src"],
    }),
  );
});

afterAll(() => {
  fs.rmSync(copy, { recursive: true, force: true });
});

/** The packs `npm run dogfood` reads a package that ships a `bin` with. */
function dogfoodPacks(): PatternPack[] {
  const packageExports: PatternPack = {
    name: "package-exports:@suss/cli",
    languages: ["typescript"],
    protocol: "in-process",
    discovery: [
      {
        kind: "library",
        match: {
          type: "packageExports",
          packageJsonPath: path.join(copy, "package.json"),
        },
      },
    ],
    terminals: [
      { kind: "return", match: { type: "returnStatement" }, extraction: {} },
      { kind: "throw", match: { type: "throwExpression" }, extraction: {} },
    ],
    inputMapping: { type: "allPositional" },
  };
  return [packageExports, nodeRuntimePack()];
}

function named(
  summaries: BehavioralSummary[],
  name: string,
): BehavioralSummary | undefined {
  return summaries.find((summary) => summary.identity.name === name);
}

describe("check:self over a CLI whose dispatch looks commands up in a table", () => {
  it("still finds the exit codes cli-check and cli-init declare", async () => {
    const runFile = path.join(copy, "src", "run.ts");
    const original = fs.readFileSync(runFile, "utf8");
    const rewritten = dispatchThroughATable(original);
    // A run.ts the pattern no longer matches would leave the `if` chain
    // in place, and the test would pass without testing a table.
    expect(rewritten).not.toContain('command === "check"');
    expect(rewritten).toContain('  "check": runCheck,');
    expect(rewritten).toContain('  "init": runInit,');
    fs.writeFileSync(runFile, rewritten);

    const adapter = createTypeScriptAdapter({
      tsConfigFilePath: path.join(copy, "tsconfig.json"),
      frameworks: dogfoodPacks(),
      cacheDir: null,
    });
    const summaries = await adapter.extractAll();

    for (const name of ["runCheck", "initInteractive"]) {
      const summary = named(summaries, name);
      expect(summary, name).toBeDefined();
      expect(
        readProcessMetadata(summary as BehavioralSummary)?.exitCodeFrom,
        name,
      ).toBe("return");
    }
    const intents = ["cli-check", "cli-init"].map((name) =>
      loadIntentFile(path.join(repoRoot, "intent", `${name}.intent.yaml`)),
    );
    // check:self runs with --fail-on warning.
    const failing = checkIntentAgreement(intents, summaries).findings.filter(
      (finding) => finding.severity !== "info",
    );
    expect(failing).toEqual([]);
  });
});
