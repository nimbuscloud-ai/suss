// queueShape.test.ts: the properties for queue consumers.
//
// Each program here is a template, a handler, and the pack options that
// say where the subject lives, so the sound tier holds two things at
// once: the shapes a consumer can be built in, and the ways a project
// can describe its own factory.
//
// This family writes files and reads a template off disk, so it costs
// more per program than the in-memory ones. The per-pull-request run
// takes a smaller sample and the scheduled run takes the volume.
//
// Knobs: SUSS_FUZZ_QUEUE_RUNS (default 40), SUSS_FUZZ_SEED.

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { QUEUE_BUGS } from "./knownBugs.js";
import { findingSignature } from "./minimize.js";
import { type QueueShapeSpec, SIMPLEST_QUEUE_SHAPE } from "./queueShape.js";
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

const BROKEN_BUILDS = new Set(QUEUE_BUGS.map((bug) => bug.value));

const arbSoundQueueShape: fc.Arbitrary<QueueShapeSpec> =
  arbQueueShapeSpec.filter((spec) => !BROKEN_BUILDS.has(spec.build));

describe("shape fuzzer, sound tier (queue consumers)", () => {
  it(
    "however the consumer is built, and however the project describes its factory, the subject it answers is the same",
    { timeout: 300_000 },
    async () => {
      await fc.assert(
        fc.asyncProperty(arbSoundQueueShape, async (spec) => {
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

describe("shape fuzzer, queue consumers that lose their subject", () => {
  for (const bug of QUEUE_BUGS) {
    it(
      `still broken, ${bug.dimension}=${bug.value}: ${bug.wrong}`,
      { timeout: 60_000 },
      async () => {
        const spec = {
          ...SIMPLEST_QUEUE_SHAPE,
          ...bug.alongside,
          [bug.dimension]: bug.value,
        } as QueueShapeSpec;
        const result = await runQueueShapeDifferential(spec);
        // Asserting the broken behaviour on purpose, so that fixing it
        // breaks this test and the value moves into the sound tier.
        expect(
          result.findings.map(findingSignature),
          `${bug.wrong}: the fuzzer no longer finds this, so it looks fixed. Move ${bug.dimension}=${bug.value} into the sound tier above and take it out of knownBugs.ts.\n${formatShapeFailure(result)}`,
        ).toContain(bug.signature);
      },
    );
  }
});
