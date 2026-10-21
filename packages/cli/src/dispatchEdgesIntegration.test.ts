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

import { createTypeScriptAdapter } from "@suss/adapter-typescript";
import { readProcessMetadata } from "@suss/behavioral-ir";
import { checkIntentAgreement } from "@suss/checker-intent";
import { loadIntentDirectory } from "@suss/contract-intent";
import { nodeRuntimePack } from "@suss/runtime-node";

import { answerQuestion } from "./ask.js";
import { relativizeSummaryPaths } from "./extract.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { PatternPack } from "@suss/extractor";

const fixtures = path.resolve(__dirname, "../../../fixtures");
const typescriptRoot = path.join(fixtures, "dispatch-edges");

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
    const possible = (name: string) =>
      named(summaries, name)
        ?.transitions.flatMap((t) => t.effects)
        .flatMap((effect) =>
          effect.type === "invocation" ? (effect.possibleSummaries ?? []) : [],
        )
        .map((id) => id.split("::").at(-1));

    expect(possible("viaNarrowedKey")).toEqual(["onCreated", "onDeleted"]);
    expect(possible("viaTable")).toEqual([
      "TABLE.archived",
      "onCreated",
      "onDeleted",
    ]);
    expect(possible("viaRegistry")).toEqual(["onArchived", "onCreated"]);
  });
});
