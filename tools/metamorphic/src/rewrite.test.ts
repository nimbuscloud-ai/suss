import { beforeAll, describe, expect, it } from "vitest";

import { describeRun } from "./extract.js";
import { REWRITES, seedProgram } from "./rewrite.js";
import { SEEDS } from "./seed.js";

import type { RunDescription } from "./extract.js";
import type { Rewrite } from "./rewrite.js";
import type { Seed } from "./seed.js";

/**
 * The rewrites suss does not follow yet, by rewrite name and then by seed,
 * each with why and where it is written down. A gap that starts passing
 * fails too, so a closed one does not stay on the list.
 */
const KNOWN_GAPS: Readonly<Record<string, Readonly<Record<string, string>>>> =
  {};

function listDifference(
  label: string,
  expected: readonly string[],
  actual: readonly string[],
): string[] {
  return [
    ...expected
      .filter((value) => !actual.includes(value))
      .map((value) => `  ${label} lost: ${value}`),
    ...actual
      .filter((value) => !expected.includes(value))
      .map((value) => `  ${label} gained: ${value}`),
  ];
}

function differenceBetween(
  seedRun: RunDescription,
  rewritten: RunDescription,
): string {
  const lines = [
    ...listDifference(
      "the boundary access",
      seedRun.effects,
      rewritten.effects,
    ),
    ...listDifference(
      "what the unit reaches",
      seedRun.reaches,
      rewritten.reaches,
    ),
  ];
  return lines.length === 0
    ? ""
    : `the rewrite describes something else:\n${lines.join("\n")}`;
}

async function problemWith(
  seed: Seed,
  rewrite: Rewrite,
  seedRun: RunDescription,
): Promise<string> {
  try {
    return differenceBetween(
      seedRun,
      await describeRun(rewrite.program(seed), seed),
    );
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

for (const seed of SEEDS) {
  describe(`${seed.name}, rewritten`, () => {
    let seedRun: RunDescription = { effects: [], reaches: [] };

    beforeAll(async () => {
      seedRun = await describeRun(seedProgram(seed), seed);
    });

    it("the seed describes exactly one boundary call the unit reaches", () => {
      expect(seedRun.effects).toHaveLength(1);
      expect(seedRun.reaches).toHaveLength(1);
    });

    for (const rewrite of REWRITES) {
      it(rewrite.name, async () => {
        const problem = await problemWith(seed, rewrite, seedRun);
        const known = KNOWN_GAPS[rewrite.name]?.[seed.name];
        if (known !== undefined) {
          expect(
            problem,
            `written down as a known gap (${known}) and now satisfied, so take it off the list`,
          ).not.toBe("");
          return;
        }
        expect(problem).toBe("");
      });
    }
  });
}
