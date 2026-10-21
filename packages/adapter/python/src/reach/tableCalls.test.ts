/**
 * Calls that take their function out of a dict, or pick it with
 * `getattr`, read by this adapter alone over the project the CLI's
 * dispatch integration test also reads. A call may run every function
 * listed in `possibleSummaries`, and a call the source narrows to one
 * function gets a `summary` instead.
 */

import path from "node:path";

import { describe, expect, it } from "vitest";

import { fastapiTestPack } from "../__fixtures__/fastapiPattern.js";
import { extractPythonProject, findPythonFiles } from "../project.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const root = path.resolve(
  __dirname,
  "../../../../../fixtures/dispatch-edges-python",
);

async function extract(): Promise<BehavioralSummary[]> {
  const { summaries } = await extractPythonProject({
    files: findPythonFiles(root),
    packs: [fastapiTestPack()],
    roots: [root],
    workspaceRoot: root,
  });
  return summaries;
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

describe("Python calls that take their function from a table", () => {
  it("follows a dict, a conditional over one, a registry and getattr to the functions each may run", async () => {
    const summaries = await extract();

    const everyHandler = ["on_archived", "on_created", "on_deleted"];
    expect(callees(summaries, "via_table", "possible")).toEqual(everyHandler);
    expect(callees(summaries, "via_get", "possible")).toEqual(everyHandler);
    expect(callees(summaries, "via_conditional", "possible")).toEqual(
      everyHandler,
    );
    expect(callees(summaries, "via_registry", "possible")).toEqual([
      "registered_created",
      "registered_deleted",
    ]);
    expect(callees(summaries, "finish", "possible")).toEqual([
      "Events.finish_created",
      "Events.finish_deleted",
    ]);
  });

  it("follows a key written out to the one function it runs", async () => {
    const summaries = await extract();

    expect(callees(summaries, "via_literal", "certain")).toEqual([
      "on_created",
    ]);
    expect(callees(summaries, "handle_named", "certain")).toEqual([
      "Events.created",
    ]);
  });
});
