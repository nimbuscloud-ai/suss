// packageShape.test.ts: the properties for the package boundary.
//
// The sound tier holds the provider side, where every way of
// publishing a function has to end up under the same export path, and
// the two ways of calling it that produce a caller unit today. The
// pinned tests hold the two that do not.
//
// Files and a manifest go to disk, so a program costs more here than in
// the in-memory families and the sample is smaller.
//
// Knobs: SUSS_FUZZ_PACKAGE_RUNS (default 40), SUSS_FUZZ_SEED.

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { PACKAGE_BUGS } from "./knownBugs.js";
import { findingSignature } from "./minimize.js";
import {
  type PackageShapeSpec,
  SIMPLEST_PACKAGE_SHAPE,
} from "./packageShape.js";
import {
  formatShapeFailure,
  runPackageShapeDifferential,
  shapeFailed,
} from "./shapeDifferential.js";
import { arbPackageShapeSpec } from "./shapeGenerators.js";

const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};

const NUM_RUNS = envInt("SUSS_FUZZ_PACKAGE_RUNS", 40);
const SEED = envInt("SUSS_FUZZ_SEED", 20260801);

const BROKEN_FORMS = new Set(PACKAGE_BUGS.map((bug) => bug.value));

const arbSoundPackageShape: fc.Arbitrary<PackageShapeSpec> =
  arbPackageShapeSpec.filter((spec) => !BROKEN_FORMS.has(spec.form));

describe("shape fuzzer, sound tier (package exports)", () => {
  it(
    "however the package publishes the function, it is summarized under the path callers name it by",
    { timeout: 300_000 },
    async () => {
      await fc.assert(
        fc.asyncProperty(arbSoundPackageShape, async (spec) => {
          const result = await runPackageShapeDifferential(spec);
          if (shapeFailed(result)) {
            throw new Error(formatShapeFailure(result));
          }
        }),
        { numRuns: NUM_RUNS, seed: SEED },
      );
    },
  );
});

describe("shape fuzzer, call sites that go unreported", () => {
  for (const bug of PACKAGE_BUGS) {
    it(
      `still broken, ${bug.dimension}=${bug.value}: ${bug.wrong}`,
      { timeout: 60_000 },
      async () => {
        const spec = {
          ...SIMPLEST_PACKAGE_SHAPE,
          ...bug.alongside,
          [bug.dimension]: bug.value,
        } as PackageShapeSpec;
        const result = await runPackageShapeDifferential(spec);
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
