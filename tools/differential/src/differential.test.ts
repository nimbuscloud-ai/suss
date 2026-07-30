// differential.test.ts — the differential fuzzer's properties.
//
// Tier structure (see generators.ts):
//
// - SOUND TIER: constructs extraction claims to model faithfully. The
//   differential property must hold — any counterexample here is an
//   undocumented extraction bug. Shrink output lands in corpus.test.ts.
// - GAP TIERS (nested / loop): constructs with *documented* soundness
//   gaps. The properties are inverted: the fuzzer is REQUIRED to find a
//   counterexample quickly. These are the mechanical rediscovery
//   milestones — when WS-2's facts-first rework closes a gap, the
//   corresponding test fails, which is the signal to promote that
//   construct into the sound tier.
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
 * Run a gap-tier arbitrary and require the fuzzer to find a genuine
 * mismatch (not a harness failure) within `numRuns` programs.
 */
async function rediscoverGap(
  arb: fc.Arbitrary<HandlerProgram>,
  numRuns: number,
): Promise<DifferentialResult> {
  let lastFailing: DifferentialResult | null = null;
  const details = await fc.check(
    fc.asyncProperty(arb, async (program: HandlerProgram) => {
      const result = await runDifferential(program);
      if (result.harnessFailures.length > 0) {
        throw new Error(`harness failure: ${formatFailure(result)}`);
      }
      if (result.mismatches.length > 0) {
        lastFailing = result;
        throw new Error(formatFailure(result));
      }
    }),
    { numRuns, seed: SEED },
  );
  expect(
    details.failed,
    "expected the fuzzer to rediscover the documented gap — if this fails, " +
      "the gap may have been fixed: promote the construct to the sound tier " +
      "and flip the corresponding corpus entries to expect clean runs",
  ).toBe(true);
  if (lastFailing === null) {
    throw new Error(
      "property failed without recording a mismatch — harness bug, not a gap rediscovery",
    );
  }
  return lastFailing;
}

describe("differential fuzzer — documented-gap rediscovery milestones", () => {
  it(
    "nested-guard arm mechanically rediscovers the nested-guard soundness gap",
    { timeout: 300_000 },
    async () => {
      const failing = await rediscoverGap(
        arbProgramWithGapConstruct(arbNestedGuard),
        100,
      );
      // The documented shape: derivation promises one status, execution
      // produces another (falseClaim), or the observed path is entirely
      // unaccounted for (uncovered).
      expect(failing.mismatches.length).toBeGreaterThan(0);
    },
  );

  it(
    "loop-guard arm mechanically rediscovers the loop-return soundness gap",
    { timeout: 300_000 },
    async () => {
      const failing = await rediscoverGap(
        arbProgramWithGapConstruct(arbLoopGuard),
        100,
      );
      expect(failing.mismatches.length).toBeGreaterThan(0);
    },
  );
});
