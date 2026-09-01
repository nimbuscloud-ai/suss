/**
 * The invoking side, read off `fixtures/lambda-invoke`. Both ways a
 * call spells its callee are in there: an env var the template points
 * at a function in the same stack, and a full ARN for one it does not
 * deploy.
 */

import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";
import { createFixtureProject } from "@suss/test-project";

import { awsLambdaFramework, clearTemplateCache } from "./index.js";

import type { BehavioralSummary, Effect } from "@suss/behavioral-ir";

const fixturesDir = path.resolve(
  __dirname,
  "../../../../fixtures/lambda-invoke",
);

/** Every unit an invoke in these summaries reaches, as it was recorded. */
function invokedUnits(summaries: BehavioralSummary[]): Array<string | null> {
  const reached: Array<string | null> = [];
  for (const summary of summaries) {
    for (const transition of summary.transitions) {
      for (const effect of transition.effects as Effect[]) {
        if (
          effect.type === "interaction" &&
          effect.interaction.class === "unit-invoke" &&
          effect.binding.semantics.name === "unit-invocation"
        ) {
          reached.push(effect.binding.semantics.instanceName);
        }
      }
    }
  }
  return reached.sort();
}

describe("awsLambdaFramework: the invoking side", () => {
  let summaries: BehavioralSummary[];

  beforeAll(async () => {
    clearTemplateCache();
    const project = createFixtureProject(fixturesDir, "src/**/*.ts");
    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [awsLambdaFramework()],
    });
    summaries = await adapter.extractAll();
  }, 60_000);

  it("keeps the env-var name a deploy-time callee arrives as", () => {
    expect(invokedUnits(summaries)).toContain("{REPORT_BUILDER_FUNCTION}");
  });

  it("takes the function out of an ARN written in full", () => {
    expect(invokedUnits(summaries)).toContain("legacy-pricing");
  });

  it("reads the fire-and-forget command as well as the waiting one", () => {
    expect(invokedUnits(summaries)).toContain("{ARCHIVE_WORKER_FUNCTION}");
  });

  it("binds each deployed function to itself, since no event reaches one", () => {
    const bound = summaries
      .map((s) => s.identity.boundaryBinding?.semantics)
      .filter((s) => s?.name === "unit-invocation")
      .map((s) => (s?.name === "unit-invocation" ? s.instanceName : null))
      .sort();
    expect(bound).toEqual(["ArchiveWorker", "OrderApi", "ReportBuilder"]);
  });
});
