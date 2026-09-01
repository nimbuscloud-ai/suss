/**
 * queueShape.test.ts: the properties for queue consumers.
 *
 * Each program is a template and a handler, so what the sound tier
 * covers is the shapes a consumer can be built in.
 *
 * This family writes files and reads a template off disk, so it costs
 * more per program than the in-memory ones. The per-pull-request run
 * takes a smaller sample and the scheduled run takes the volume.
 *
 * Knobs: SUSS_FUZZ_QUEUE_RUNS (default 40), SUSS_FUZZ_SEED.
 */

import fc from "fast-check";
import { describe, it } from "vitest";

import {
  formatShapeFailure,
  runQueueShapeDifferential,
  shapeFailed,
} from "./shapeDifferential.js";
import { arbQueueShapeSpec } from "./shapeGenerators.js";

const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};

const NUM_RUNS = envInt("SUSS_FUZZ_QUEUE_RUNS", 40);
const SEED = envInt("SUSS_FUZZ_SEED", 20260801);

describe("shape fuzzer, sound tier (queue consumers)", () => {
  it(
    "however the consumer is built, it is one unit behind the same bus",
    { timeout: 300_000 },
    async () => {
      await fc.assert(
        fc.asyncProperty(arbQueueShapeSpec, async (spec) => {
          const result = await runQueueShapeDifferential(spec);
          if (shapeFailed(result)) {
            throw new Error(formatShapeFailure(result));
          }
        }),
        { numRuns: NUM_RUNS, seed: SEED },
      );
    },
  );
});
