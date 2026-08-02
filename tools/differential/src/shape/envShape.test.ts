// envShape.test.ts: the properties for runtime configuration reads.
//
// The sound tier is every place a read can sit crossed with every way
// it can be spelled, and nothing is pinned: the pack reads all of them.
//
// Knobs: SUSS_FUZZ_RUNS (default 150), SUSS_FUZZ_SEED.

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  formatShapeFailure,
  runEnvShapeDifferential,
  shapeFailed,
} from "./shapeDifferential.js";
import { arbEnvShapeSpec } from "./shapeGenerators.js";

const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};

const NUM_RUNS = envInt("SUSS_FUZZ_RUNS", 150);
const SEED = envInt("SUSS_FUZZ_SEED", 20260801);

describe("shape fuzzer, sound tier (runtime configuration)", () => {
  it(
    "wherever in the module the read sits, however it is spelled, the variable it names is reported",
    { timeout: 300_000 },
    async () => {
      await fc.assert(
        fc.asyncProperty(arbEnvShapeSpec, async (spec) => {
          const result = await runEnvShapeDifferential(spec);
          if (shapeFailed(result)) {
            throw new Error(formatShapeFailure(result));
          }
        }),
        { numRuns: NUM_RUNS, seed: SEED },
      );
    },
  );
});

describe("shape fuzzer, config reads at the module's own load", () => {
  it(
    "reports the read against the module, not against a handler that never performs it",
    { timeout: 60_000 },
    async () => {
      const result = await runEnvShapeDifferential({
        site: "atModuleScope",
        form: "dotted",
        varName: "SERVICE_URL",
      });
      const reading = result.summaries.filter((summary) =>
        summary.transitions.some((transition) =>
          (transition.effects ?? []).some(
            (effect) =>
              effect.type === "interaction" &&
              effect.interaction.class === "config-read",
          ),
        ),
      );
      expect(reading.map((summary) => summary.kind)).toEqual(["module-init"]);
    },
  );
});
