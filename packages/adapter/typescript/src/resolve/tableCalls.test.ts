/**
 * Calls that take their function out of a record, a map or a registry,
 * read by this adapter alone over the project the CLI's dispatch
 * integration test also reads. A call may run every function listed in
 * `possibleSummaries`, and a call the source narrows to one function gets
 * a `summary` instead.
 */

import path from "node:path";

import { describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "../adapter.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { PatternPack } from "@suss/extractor";

const root = path.resolve(__dirname, "../../../../../fixtures/dispatch-edges");

const packageExports: PatternPack = {
  name: "package-exports:dispatch-edges",
  languages: ["typescript"],
  protocol: "in-process",
  discovery: [
    {
      kind: "library",
      match: {
        type: "packageExports",
        packageJsonPath: path.join(root, "package.json"),
      },
    },
  ],
  terminals: [
    { kind: "return", match: { type: "returnStatement" }, extraction: {} },
  ],
  inputMapping: { type: "allPositional" },
};

async function extract(): Promise<BehavioralSummary[]> {
  const adapter = createTypeScriptAdapter({
    tsConfigFilePath: path.join(root, "tsconfig.json"),
    frameworks: [packageExports],
    cacheDir: null,
  });
  return await adapter.extractAll();
}

/** The last part of each summary id a unit's calls point at, possible ones or certain ones. */
function callees(
  summaries: BehavioralSummary[],
  name: string,
  which: "possible" | "certain",
): string[] {
  const unit = summaries.find((summary) => summary.identity.name === name);
  return (unit?.transitions ?? [])
    .flatMap((transition) => transition.effects)
    .flatMap((effect) => {
      if (effect.type !== "invocation") {
        return [];
      }
      if (which === "possible") {
        return effect.possibleSummaries ?? [];
      }
      return effect.summary === undefined ? [] : [effect.summary];
    })
    .map((id) => id.split("::").at(-1) ?? id);
}

describe("TypeScript calls that take their function from a table", () => {
  it("follows a record, a conditional, a map and a registry to the functions each may run", async () => {
    const summaries = await extract();

    const everyEntry = ["TABLE.archived", "onCreated", "onDeleted"];
    expect(callees(summaries, "viaTable", "possible")).toEqual(everyEntry);
    expect(callees(summaries, "viaConditional", "possible")).toEqual(
      everyEntry,
    );
    expect(callees(summaries, "viaNarrowedKey", "possible")).toEqual([
      "onCreated",
      "onDeleted",
    ]);
    expect(callees(summaries, "viaTemplateKey", "possible")).toEqual([
      "onCreated",
      "onDeleted",
    ]);
    expect(callees(summaries, "viaMap", "possible")).toEqual([
      "onCreated",
      "onDeleted",
    ]);
    expect(callees(summaries, "viaRegistry", "possible")).toEqual([
      "onArchived",
      "onCreated",
    ]);
    expect(callees(summaries, "dispatch", "possible")).toEqual([
      "runCheck",
      "runInit",
    ]);
  });

  it("follows a key written out, and a function handed to a helper, to the one function it runs", async () => {
    const summaries = await extract();

    expect(callees(summaries, "viaLiteralKey", "certain")).toEqual([
      "onCreated",
    ]);
    expect(callees(summaries, "viaClosure", "certain")).toContain("onCreated");
  });
});
