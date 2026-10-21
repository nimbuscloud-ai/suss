/**
 * Calls that take their method out of a hash, or pick it with `send`, read
 * by this adapter alone over the project the CLI's dispatch integration
 * test also reads. A call may run every method listed in
 * `possibleSummaries`, and a call the source narrows to one method gets a
 * `summary` instead.
 */

import path from "node:path";

import { describe, expect, it } from "vitest";

import { railsTestPack } from "../__fixtures__/railsControllerPattern.js";
import { extractRubyProject, findRubyFiles } from "../project.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const root = path.resolve(
  __dirname,
  "../../../../../fixtures/dispatch-edges-ruby",
);

async function extract(): Promise<BehavioralSummary[]> {
  const { summaries } = await extractRubyProject({
    files: findRubyFiles(root),
    packs: [
      railsTestPack({
        routesFor: (_controller, action) => [
          { method: "POST", path: `/events/${action}` },
        ],
      }),
    ],
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

describe("Ruby calls that take their method from a table", () => {
  it("follows a hash of lambdas, a conditional over one, and send to the methods each may run", async () => {
    const summaries = await extract();

    expect(callees(summaries, "via_table", "possible")).toEqual([
      "EventHandlers.on_created",
      "EventHandlers.on_deleted",
    ]);
    expect(callees(summaries, "via_conditional", "possible")).toEqual([
      "EventHandlers.on_created",
      "EventHandlers.on_deleted",
    ]);
    expect(callees(summaries, "via_method_table", "possible")).toEqual([
      "EventHandlers.on_archived",
    ]);
    expect(callees(summaries, "finish", "possible")).toEqual([
      "EventHandlers.finish_created",
      "EventHandlers.finish_deleted",
    ]);
  });

  it("follows a name written out in send to the one method it runs", async () => {
    const summaries = await extract();

    expect(callees(summaries, "consume_literal", "certain")).toEqual([
      "EventHandlers.created",
    ]);
    expect(callees(summaries, "via_proc", "certain")).toContain(
      "EventHandlers.on_deleted",
    );
  });
});
