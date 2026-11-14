/**
 * A plain Ruby project whose Sidekiq job includes an ActiveSupport
 * concern, extracted with the sidekiq pack and no rails pack. The
 * concern reads the environment in its `included` block and in a method
 * defined inside that block, which the job calls. Only the rails pack
 * declares those blocks, and reading them must not depend on it being
 * in the run. Without it, the `class_methods` method is read as an
 * instance method, so the job's class-level call does not reach it.
 */

import path from "node:path";

import { describe, expect, it } from "vitest";

import { extractRubyProject, findRubyFiles } from "@suss/adapter-ruby";
import sidekiqFramework from "@suss/packs/sidekiq";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const fixtureRoot = path.resolve(
  __dirname,
  "../../../fixtures/ruby-concern-env",
);

/** Each summary's name with the config reads in it, as `NAME:defaulted`. */
function readsBySummary(
  summaries: readonly BehavioralSummary[],
): Record<string, string[]> {
  const reads: Record<string, string[]> = {};
  for (const summary of summaries) {
    const found = new Set<string>();
    const walk = (value: unknown): void => {
      if (value === null || typeof value !== "object") {
        return;
      }
      const interaction = (value as { interaction?: Record<string, unknown> })
        .interaction;
      if (interaction?.class === "config-read") {
        found.add(
          `${String(interaction.name)}:${String(interaction.defaulted)}`,
        );
      }
      for (const inner of Object.values(value)) {
        walk(inner);
      }
    };
    walk(summary);
    if (found.size > 0) {
      reads[summary.identity.name] = [...found];
    }
  }
  return reads;
}

describe("an ActiveSupport concern in a project without Rails", () => {
  it("keeps the reads in its included block and in the method defined there", async () => {
    const { summaries } = await extractRubyProject({
      files: findRubyFiles(fixtureRoot),
      packs: [sidekiqFramework()],
      projectRoot: fixtureRoot,
      cacheDir: null,
    });
    expect(readsBySummary(summaries)).toEqual({
      "throttled.rb": ["THROTTLE_LIMIT:true"],
      throttle_key: ["THROTTLE_PREFIX:true"],
    });
  });
});
