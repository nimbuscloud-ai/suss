// resolverShape.test.ts: the properties for the two GraphQL families.
//
// Same protocol as the rest of the shape fuzzer: a sound tier that has
// to hold, and one inverted property per pinned bug, so a gap can
// neither grow nor quietly close.
//
// Knobs: SUSS_FUZZ_RUNS (default 150), SUSS_FUZZ_SEED.

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { APOLLO_RESOLVER_BUGS, NEST_RESOLVER_BUGS } from "./knownBugs.js";
import { findingSignature, signaturesOf } from "./minimize.js";
import {
  type ApolloResolverSpec,
  type NestResolverSpec,
  SIMPLEST_APOLLO_RESOLVER,
  SIMPLEST_NEST_RESOLVER,
} from "./resolverShape.js";
import {
  formatShapeFailure,
  runApolloResolverDifferential,
  runNestResolverDifferential,
  shapeFailed,
} from "./shapeDifferential.js";
import {
  arbApolloResolverSpec,
  arbNestResolverSpec,
} from "./shapeGenerators.js";

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

// ---------------------------------------------------------------------------
// Sound tier
// ---------------------------------------------------------------------------

const arbSoundApolloShape: fc.Arbitrary<ApolloResolverSpec> =
  arbApolloResolverSpec;

const arbSoundNestShape: fc.Arbitrary<NestResolverSpec> =
  arbNestResolverSpec.filter(
    (spec) =>
      spec.method !== "arrowProperty" &&
      !(
        spec.announcement === "noTypeArgument" &&
        spec.operation === "ResolveField"
      ),
  );

describe("shape fuzzer, sound tier (apollo)", () => {
  it(
    "however the resolver map reaches the constructor, the field it answers is the same",
    { timeout: 300_000 },
    async () => {
      await fc.assert(
        fc.asyncProperty(arbSoundApolloShape, async (spec) => {
          const result = await runApolloResolverDifferential(spec);
          if (shapeFailed(result)) {
            throw new Error(formatShapeFailure(result));
          }
        }),
        { numRuns: NUM_RUNS, seed: SEED },
      );
    },
  );
});

describe("shape fuzzer, sound tier (nestjs-graphql)", () => {
  it(
    "however the class announces itself, the field the method answers is the same",
    { timeout: 300_000 },
    async () => {
      await fc.assert(
        fc.asyncProperty(arbSoundNestShape, async (spec) => {
          const result = await runNestResolverDifferential(spec);
          if (shapeFailed(result)) {
            throw new Error(formatShapeFailure(result));
          }
        }),
        { numRuns: NUM_RUNS, seed: SEED },
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Bugs that are in the tree today. Each asserts the WRONG behaviour, so
// fixing one breaks the test and whoever fixed it promotes the
// dimension value into the sound tier above.
// ---------------------------------------------------------------------------

describe("shape fuzzer, resolver bugs that are still in the tree", () => {
  for (const bug of APOLLO_RESOLVER_BUGS) {
    it(
      `still broken, apollo ${bug.dimension}=${bug.value}: ${bug.wrong}`,
      { timeout: 60_000 },
      async () => {
        const spec = {
          ...SIMPLEST_APOLLO_RESOLVER,
          ...bug.alongside,
          [bug.dimension]: bug.value,
        } as ApolloResolverSpec;
        const result = await runApolloResolverDifferential(spec);
        expect(
          [...signaturesOf(result)],
          `${bug.wrong}: the fuzzer no longer finds this, so it looks fixed. Move ${bug.dimension}=${bug.value} into the sound tier above and take it out of knownBugs.ts.\n${formatShapeFailure(result)}`,
        ).toContain(bug.signature);
      },
    );
  }

  for (const bug of NEST_RESOLVER_BUGS) {
    it(
      `still broken, nestjs-graphql ${bug.dimension}=${bug.value}: ${bug.wrong}`,
      { timeout: 60_000 },
      async () => {
        const spec = {
          ...SIMPLEST_NEST_RESOLVER,
          ...bug.alongside,
          [bug.dimension]: bug.value,
        } as NestResolverSpec;
        const result = await runNestResolverDifferential(spec);
        expect(
          result.findings.map(findingSignature),
          `${bug.wrong}: the fuzzer no longer finds this, so it looks fixed. Move ${bug.dimension}=${bug.value} into the sound tier above and take it out of knownBugs.ts.\n${formatShapeFailure(result)}`,
        ).toContain(bug.signature);
      },
    );
  }
});
