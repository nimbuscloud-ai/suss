/**
 * The gate: generate the fact bases, run the rules, compare what came
 * out against the committed baseline.
 *
 * Four thousand bases run on every pull request. The first five hundred
 * have a committed line each, which is the diff a reviewer reads; the
 * rest are covered by one committed digest, which is what keeps a file
 * that covers four thousand bases down to five hundred lines.
 * `npm run resolution:baseline` rewrites it.
 */

import { describe, expect, it } from "vitest";

import { answersFor, QUESTIONS } from "./answers.js";
import {
  BASELINE_NAME,
  baselineFrom,
  caseLine,
  readBaseline,
  sweepOf,
  writeBaseline,
} from "./baselineFile.js";
import { factBase, factBases, STATED_RELATIONS } from "./factBases.js";
import { headerReport, movedReport, sweepReport } from "./report.js";

import type { Answers } from "./answers.js";
import type { Baseline } from "./baselineFile.js";
import type { Moved } from "./report.js";

/**
 * The run the committed file was written for. The seed rewrites every
 * line if it moves, so it moves only when somebody means it. The other
 * two are floors: a baseline may cover more than this, which is how a
 * reviewer narrows down a digest that moved, and never less.
 */
const SEED = 20260817;
const LINES = Number(process.env.RESOLUTION_LINES ?? 500);
const BASES = Number(process.env.RESOLUTION_BASES ?? 4000);

const UPDATING = process.env.RESOLUTION_BASELINE === "update";

const answersOver = (count: number): Answers[] =>
  factBases(SEED, 0, count).map(answersFor);

describe.skipIf(UPDATING)("what the resolution rules derive", () => {
  const committed = readBaseline();

  // Generated once for the whole file, and behind a function so that a
  // run which skips this suite never pays for it.
  let generated: Answers[] | null = null;
  const every = (): Answers[] => {
    generated ??= answersOver(Math.max(committed?.sweep.bases ?? BASES, BASES));
    return generated;
  };
  const fresh = (): Baseline =>
    baselineFrom(SEED, committed?.bases ?? LINES, every());

  it("matches the committed answers, base by base", () => {
    expect(
      committed,
      `${BASELINE_NAME} is missing. Run \`npm run resolution:baseline\`.`,
    ).not.toBeNull();
    const baseline = committed as NonNullable<typeof committed>;
    const now = fresh();

    if (
      baseline.seed !== now.seed ||
      baseline.questions.join() !== now.questions.join()
    ) {
      throw new Error(headerReport(baseline, now));
    }

    const moved: Moved[] = [];
    every()
      .slice(0, baseline.bases)
      .forEach((answers, at) => {
        const line = baseline.cases[at];
        if (line !== undefined && line !== caseLine(answers)) {
          moved.push({ answers, committed: line });
        }
      });

    if (moved.length > 0) {
      throw new Error(movedReport(SEED, baseline, now, moved));
    }
  });

  it("matches the committed digest over every base past those", () => {
    const baseline = committed as NonNullable<typeof committed>;
    const sweep = sweepOf(every().slice(0, baseline.sweep.bases));
    if (sweep.digest !== baseline.sweep.digest) {
      throw new Error(sweepReport(baseline, sweep));
    }
  });

  it("covers at least as many bases as the gate was set to", () => {
    const baseline = committed as NonNullable<typeof committed>;
    expect(baseline.bases).toBeGreaterThanOrEqual(LINES);
    expect(baseline.sweep.bases).toBeGreaterThanOrEqual(BASES);
  });

  it("puts every question to work in some of the bases", () => {
    const { reach } = fresh();
    const idle = QUESTIONS.filter((question) => reach[question] === 0);
    expect(
      idle,
      "a question no generated base derives anything for is a question this gate cannot see a change to",
    ).toEqual([]);
  });

  it("states every fact the rules read", () => {
    const drawn = new Set<string>();
    for (let index = 0; index < LINES; index += 1) {
      for (const [relation] of factBase(SEED, index).facts) {
        drawn.add(relation);
      }
    }
    expect([...drawn].sort()).toEqual([...STATED_RELATIONS].sort());
  });
});

describe.runIf(UPDATING)("rewriting the committed baseline", () => {
  it("writes what the rules derive today", () => {
    const fresh = baselineFrom(SEED, LINES, answersOver(BASES));
    writeBaseline(fresh);
    expect(fresh.cases).toHaveLength(LINES);
  });
});
