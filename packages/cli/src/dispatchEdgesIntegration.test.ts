/**
 * Calls that take their function out of a table, or out of a closure
 * handed to a helper, through the pipeline a user runs: extract, write
 * the summaries, then ask what calls a function and check the intent.
 *
 * The TypeScript project dispatches its commands the way suss's own CLI
 * could, through a `COMMANDS` record called inside a closure. Its exit
 * codes come from the commands, so the intent check finds them only when
 * the call through the table is followed.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { extractPythonProject, findPythonFiles } from "@suss/adapter-python";
import { createTypeScriptAdapter } from "@suss/adapter-typescript";
import { readProcessMetadata } from "@suss/behavioral-ir";
import { checkIntentAgreement } from "@suss/checker-intent";
import { loadIntentDirectory } from "@suss/contract-intent";
import fastapi from "@suss/packs/fastapi";
import { nodeRuntimePack } from "@suss/runtime-node";

import { answerQuestion } from "./ask.js";
import { relativizeSummaryPaths } from "./extract.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { PatternPack } from "@suss/extractor";

const fixtures = path.resolve(__dirname, "../../../fixtures");
const typescriptRoot = path.join(fixtures, "dispatch-edges");
const pythonRoot = path.join(fixtures, "dispatch-edges-python");

/** The pack the dogfood run reads each workspace package with. */
const packageExports: PatternPack = {
  name: "package-exports:dispatch-edges",
  languages: ["typescript"],
  protocol: "in-process",
  discovery: [
    {
      kind: "library",
      match: {
        type: "packageExports",
        packageJsonPath: path.join(typescriptRoot, "package.json"),
      },
    },
  ],
  terminals: [
    { kind: "return", match: { type: "returnStatement" }, extraction: {} },
    { kind: "throw", match: { type: "throwExpression" }, extraction: {} },
  ],
  inputMapping: { type: "allPositional" },
};

let out: string;

beforeEach(() => {
  out = fs.mkdtempSync(path.join(os.tmpdir(), "suss-dispatch-edges-"));
});

afterEach(() => {
  fs.rmSync(out, { recursive: true, force: true });
});

async function typescriptSummaries(): Promise<BehavioralSummary[]> {
  const adapter = createTypeScriptAdapter({
    tsConfigFilePath: path.join(typescriptRoot, "tsconfig.json"),
    frameworks: [packageExports, nodeRuntimePack()],
    cacheDir: null,
  });
  const summaries = await adapter.extractAll();
  for (const summary of summaries) {
    relativizeSummaryPaths(summary, typescriptRoot);
  }
  return summaries;
}

/** Writes the summaries where `suss ask` reads them, and asks. */
function ask(summaries: BehavioralSummary[], question: string): string {
  fs.writeFileSync(path.join(out, "code.json"), JSON.stringify(summaries));
  const answer = path.join(out, "answer.txt");
  const { exitCode } = answerQuestion({ question, dir: out, output: answer });
  expect(exitCode).toBe(0);
  return fs.readFileSync(answer, "utf8");
}

function named(
  summaries: BehavioralSummary[],
  name: string,
): BehavioralSummary | undefined {
  return summaries.find((summary) => summary.identity.name === name);
}

describe("a TypeScript command table", () => {
  it("finds the exit codes of the commands a COMMANDS record dispatches to", async () => {
    const summaries = await typescriptSummaries();

    for (const name of ["runCheck", "runInit", "initInteractive"]) {
      expect(
        readProcessMetadata(named(summaries, name) as BehavioralSummary)
          ?.exitCodeFrom,
      ).toBe("return");
    }
    const intents = loadIntentDirectory(path.join(typescriptRoot, "intent"));
    expect(checkIntentAgreement(intents, summaries).findings).toEqual([]);
  });

  it("says the dispatcher may call each command, and calls neither for sure", async () => {
    const text = ask(await typescriptSummaries(), "what calls runCheck");

    expect(text).toContain("1 unit may call");
    expect(text).toContain(
      "src/run.ts::dispatch (src/run.ts:13) calls run, which may run",
    );
  });
});

describe("TypeScript calls through a table, a map, a registry and a closure", () => {
  it("lists every caller of a handler, and which of them may run another one", async () => {
    const text = ask(await typescriptSummaries(), "what calls onCreated");

    expect(text).toContain("6 units call");
    expect(text).toMatch(
      /viaLiteralKey \(src\/shapes\.ts:\d+, [^)]*\) calls TABLE\["created"\]\n/,
    );
    expect(text).toMatch(
      /viaClosure \(src\/shapes\.ts:\d+, [^)]*\) calls onCreated\n/,
    );
    for (const caller of [
      "viaTable",
      "viaNarrowedKey",
      "viaMap",
      "viaRegistry",
    ]) {
      expect(text).toMatch(
        new RegExp(
          `${caller} \\(src/shapes\\.ts:\\d+, [^)]*\\) calls .*, which may run`,
        ),
      );
    }
    expect(text).not.toContain("could be hidden");
  });

  it("keeps a key narrowed to two names to the two entries under them", async () => {
    const summaries = await typescriptSummaries();

    expect(possible(summaries, "viaNarrowedKey")).toEqual([
      "onCreated",
      "onDeleted",
    ]);
    expect(possible(summaries, "viaTable")).toEqual([
      "TABLE.archived",
      "onCreated",
      "onDeleted",
    ]);
    expect(possible(summaries, "viaRegistry")).toEqual([
      "onArchived",
      "onCreated",
    ]);
  });
});

describe("Python calls through a dict, getattr, a decorator registry and a lambda", () => {
  it("finds the exit codes of the commands a dict dispatches to", async () => {
    const summaries = await pythonSummaries();

    expect(possible(summaries, "main")).toEqual(["run_check", "run_init"]);
    for (const name of ["run_check", "run_init"]) {
      expect(
        readProcessMetadata(named(summaries, name) as BehavioralSummary)
          ?.exitCodeFrom,
      ).toBe("return");
    }
  });

  it("follows each shape to the functions it may run, and a written key to the one it runs", async () => {
    const summaries = await pythonSummaries();

    expect(possible(summaries, "via_table")).toEqual([
      "on_archived",
      "on_created",
      "on_deleted",
    ]);
    expect(possible(summaries, "via_get")).toEqual([
      "on_archived",
      "on_created",
      "on_deleted",
    ]);
    expect(possible(summaries, "via_registry")).toEqual([
      "registered_created",
      "registered_deleted",
    ]);
    expect(possible(summaries, "handle")).toEqual([
      "Events.created",
      "Events.deleted",
      "Events.handle",
      "Events.handle_named",
    ]);
    expect(calledFor(summaries, "via_literal")).toEqual(["on_created"]);
    expect(calledFor(summaries, "handle_named")).toEqual(["Events.created"]);
  });

  it("says which routes may call a handler, and which call it for sure", async () => {
    const text = ask(await pythonSummaries(), "what calls on_created");

    expect(text).toMatch(/via_literal \([^)]*\) calls HANDLERS\["created"\]\n/);
    expect(text).toMatch(/via_closure \([^)]*\) calls on_created\n/);
    expect(text).toMatch(
      /via_table \([^)]*\) calls HANDLERS\[kind\], which may run/,
    );
    expect(text).toMatch(/via_get \([^)]*\) calls handler, which may run/);
  });
});

async function pythonSummaries(): Promise<BehavioralSummary[]> {
  const { summaries } = await extractPythonProject({
    files: findPythonFiles(pythonRoot),
    packs: [fastapi()],
    roots: [pythonRoot],
    projectRoot: pythonRoot,
  });
  for (const summary of summaries) {
    relativizeSummaryPaths(summary, pythonRoot);
  }
  return summaries;
}

/** The functions a unit's calls may run, by the last part of each summary's id. */
function possible(
  summaries: BehavioralSummary[],
  name: string,
): string[] | undefined {
  return named(summaries, name)
    ?.transitions.flatMap((t) => t.effects)
    .flatMap((effect) =>
      effect.type === "invocation" ? (effect.possibleSummaries ?? []) : [],
    )
    .map((id) => id.split("::").at(-1) ?? id);
}

/** The functions a unit's calls run for sure, the same way. */
function calledFor(
  summaries: BehavioralSummary[],
  name: string,
): string[] | undefined {
  return named(summaries, name)
    ?.transitions.flatMap((t) => t.effects)
    .flatMap((effect) =>
      effect.type === "invocation" && effect.summary !== undefined
        ? [effect.summary]
        : [],
    )
    .map((id) => id.split("::").at(-1) ?? id);
}
