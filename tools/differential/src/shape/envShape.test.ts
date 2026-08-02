// envShape.test.ts: the properties for runtime configuration reads.
//
// The sound tier is every place a read can sit that the pack does look
// in, crossed with the two spellings it does read. The pinned tests
// below hold the three it misses.
//
// Knobs: SUSS_FUZZ_RUNS (default 150), SUSS_FUZZ_SEED.

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { type EnvShapeSpec, SIMPLEST_ENV_SHAPE } from "./envShape.js";
import { ENV_BUGS } from "./knownBugs.js";
import { findingSignature } from "./minimize.js";
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

const arbSoundEnvShape: fc.Arbitrary<EnvShapeSpec> = arbEnvShapeSpec.filter(
  (spec) =>
    spec.site !== "atModuleScope" &&
    spec.form !== "bracket" &&
    spec.form !== "destructured",
);

describe("shape fuzzer, sound tier (runtime configuration)", () => {
  it(
    "wherever inside the unit the read sits, the variable it names is reported",
    { timeout: 300_000 },
    async () => {
      await fc.assert(
        fc.asyncProperty(arbSoundEnvShape, async (spec) => {
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

describe("shape fuzzer, config reads that are still missed", () => {
  for (const bug of ENV_BUGS) {
    it(
      `still broken, ${bug.dimension}=${bug.value}: ${bug.wrong}`,
      { timeout: 60_000 },
      async () => {
        const spec: EnvShapeSpec = {
          ...SIMPLEST_ENV_SHAPE,
          varName: "SERVICE_URL",
          ...bug.alongside,
          [bug.dimension]: bug.value,
        } as EnvShapeSpec;
        const result = await runEnvShapeDifferential(spec);
        // Asserting the broken behaviour on purpose: this fails the
        // moment the read is picked up, which is when the dimension
        // value belongs in the sound tier instead.
        expect(
          result.findings.map(findingSignature),
          `${bug.wrong}: the fuzzer no longer finds this, so it looks fixed. Move ${bug.dimension}=${bug.value} into the sound tier above and take it out of knownBugs.ts.\n${formatShapeFailure(result)}`,
        ).toContain(bug.signature);
      },
    );
  }
});
