// differential.test.ts — the differential fuzzer's properties.
//
// The sound tier (see generators.ts) must hold: any counterexample is
// an undocumented extraction bug; shrink output lands in
// corpus.test.ts. Nested guards and loop guards were gap-tier
// constructs with *inverted* milestone properties (the fuzzer was
// required to keep rediscovering each documented gap) until the CFG
// path engine closed both — the former milestones below now assert
// the promoted constructs stay sound, with generators that force the
// once-broken shapes into every program.
//
// Knobs: SUSS_FUZZ_RUNS (sound-tier run count, default 60),
// SUSS_FUZZ_SEED (fast-check seed, default fixed for CI determinism).

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { type DifferentialResult, runDifferential } from "./differential.js";
import {
  arbHandlerProgram,
  arbLoopGuard,
  arbNestedGuard,
  arbProgramWithGapConstruct,
  SOUND_TIER,
} from "./generators.js";
import { ALL_TARGETS } from "./target.js";

import type { HandlerProgram } from "./program.js";

const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};

const NUM_RUNS = envInt("SUSS_FUZZ_RUNS", 60);
const SEED = envInt("SUSS_FUZZ_SEED", 20260730);

function formatFailure(result: DifferentialResult): string {
  const lines = [
    "differential mismatch",
    "",
    "=== module ===",
    result.moduleSource,
    "=== mismatches ===",
    ...result.mismatches.map(
      (m) =>
        `${m.verdict}: ${m.detail}\n  request: ${JSON.stringify(m.request)}`,
    ),
    "=== harness failures ===",
    ...result.harnessFailures.map(
      (f) => `${f.message}\n  request: ${JSON.stringify(f.request)}`,
    ),
  ];
  return lines.join("\n");
}

// The sound tier runs against every wired target: same DSL, same
// interpreter, same adjudicator — only the pack, the terminal syntax,
// and the response stub vary. A second framework passing here is the
// evidence the harness generalizes across the existing setups rather
// than encoding Express-isms.
for (const target of ALL_TARGETS) {
  describe(`differential fuzzer — sound tier (${target.name})`, () => {
    it(
      "extraction over sound constructs never makes a false claim and always covers observed behavior",
      { timeout: 300_000 },
      async () => {
        await fc.assert(
          fc.asyncProperty(
            arbHandlerProgram(SOUND_TIER),
            async (program: HandlerProgram) => {
              const result = await runDifferential(program, target);
              if (
                result.mismatches.length > 0 ||
                result.harnessFailures.length > 0
              ) {
                throw new Error(formatFailure(result));
              }
            },
          ),
          { numRuns: NUM_RUNS, seed: SEED },
        );
      },
    );

    it(
      "extraction is deterministic — the same program yields the same summary",
      { timeout: 60_000 },
      async () => {
        await fc.assert(
          fc.asyncProperty(
            arbHandlerProgram(SOUND_TIER),
            async (program: HandlerProgram) => {
              const first = await runDifferential(program, target);
              const second = await runDifferential(program, target);
              expect(second.summary).toEqual(first.summary);
            },
          ),
          { numRuns: 5, seed: SEED },
        );
      },
    );
  });
}

/**
 * Assert a construct-forcing arbitrary stays sound: no mismatch and no
 * harness failure across the run budget.
 */
async function assertConstructSound(
  arb: fc.Arbitrary<HandlerProgram>,
  numRuns: number,
): Promise<void> {
  await fc.assert(
    fc.asyncProperty(arb, async (program: HandlerProgram) => {
      const result = await runDifferential(program);
      if (result.mismatches.length > 0 || result.harnessFailures.length > 0) {
        throw new Error(formatFailure(result));
      }
    }),
    { numRuns, seed: SEED },
  );
}

describe("differential fuzzer — promoted constructs stay sound", () => {
  // These were the documented-gap rediscovery milestones (inverted
  // properties) before the CFG path engine closed the nested-guard and
  // loop-return gaps. The same generators now run as regular sound
  // properties, forcing the once-broken construct into every program.
  it(
    "programs forced to contain a nested guard extract soundly",
    { timeout: 300_000 },
    async () => {
      await assertConstructSound(
        arbProgramWithGapConstruct(arbNestedGuard),
        100,
      );
    },
  );

  it(
    "programs forced to contain a loop guard extract soundly",
    { timeout: 300_000 },
    async () => {
      await assertConstructSound(arbProgramWithGapConstruct(arbLoopGuard), 100);
    },
  );
});
