// fuzzPython.mjs: the Python differential run.
//
// Samples program specs for both Python packs, renders and extracts
// each one, runs the whole batch under python3 (the CI image's or the
// developer's own; the shipped package never carries an interpreter),
// and adjudicates claims against what each app actually served. The
// run fails on any falseClaim, uncovered, or harness failure, and it
// prints the abstention rate either way: abstaining is never
// penalized, and a cost metric nobody prints is a cost nobody sees.
//
// Usage: node fuzzPython.mjs [programs] [seed]
// The seed defaults to the fixed one the property suites use, so a
// bare run is reproducible; the scheduled workflow passes a clock
// seed to reach shapes the fixed one never draws.
// SUSS_FUZZ_PYTHON points at the interpreter (default: python3).

import fc from "fast-check";

import {
  arbPythonProgramSpec,
  assertPythonEnvironment,
  DEFAULT_PYTHON,
  formatPythonFailure,
  pythonProgramFailed,
  runPythonDifferentialBatch,
} from "./dist/index.js";

const DEFAULT_SEED = 20260730;
const BATCH_SIZE = 40;

const programs = Number.parseInt(
  process.argv[2] ?? process.env.SUSS_FUZZ_PYTHON_RUNS ?? "200",
  10,
);
const seed = Number.parseInt(process.argv[3] ?? String(DEFAULT_SEED), 10);

const pythonVersion = assertPythonEnvironment(DEFAULT_PYTHON);
console.log(
  `python differential: seed ${seed}, ${programs} programs, ` +
    `${DEFAULT_PYTHON} (Python ${pythonVersion})`,
);

const specs = fc.sample(arbPythonProgramSpec, { numRuns: programs, seed });
const started = performance.now();

const totals = {
  programs: 0,
  intents: 0,
  claimed: 0,
  abstained: 0,
  falseClaims: 0,
  uncovered: 0,
  harnessFailures: 0,
};
const perFramework = new Map();
let failingPrograms = 0;

for (let offset = 0; offset < specs.length; offset += BATCH_SIZE) {
  const batch = specs.slice(offset, offset + BATCH_SIZE);
  const { results } = await runPythonDifferentialBatch(batch);
  for (const result of results) {
    const bucket = perFramework.get(result.rendered.framework) ?? {
      programs: 0,
      intents: 0,
      claimed: 0,
      abstained: 0,
      falseClaims: 0,
      uncovered: 0,
      harnessFailures: 0,
    };
    bucket.programs += 1;
    bucket.intents += result.judgment.intentsTotal;
    bucket.claimed += result.judgment.claimedIntents;
    bucket.abstained += result.judgment.abstainedIntents;
    perFramework.set(result.rendered.framework, bucket);

    totals.programs += 1;
    totals.intents += result.judgment.intentsTotal;
    totals.claimed += result.judgment.claimedIntents;
    totals.abstained += result.judgment.abstainedIntents;
    // Verdicts count into the framework's own bucket as well as the
    // totals: the scheduled run's log is read per pack, and a
    // falseClaim only the aggregate line carries makes the reader
    // dig through the detailed dump to learn whose it was.
    for (const finding of result.judgment.findings) {
      if (finding.verdict === "falseClaim") {
        totals.falseClaims += 1;
        bucket.falseClaims += 1;
      }
      if (finding.verdict === "uncovered") {
        totals.uncovered += 1;
        bucket.uncovered += 1;
      }
      if (finding.verdict === "harnessFailure") {
        totals.harnessFailures += 1;
        bucket.harnessFailures += 1;
      }
    }
    if (pythonProgramFailed(result)) {
      failingPrograms += 1;
      console.error(`\n${formatPythonFailure(result)}\n`);
    }
  }
}

const seconds = (performance.now() - started) / 1000;
for (const [framework, bucket] of perFramework) {
  const rate = bucket.intents > 0 ? bucket.abstained / bucket.intents : 0;
  console.log(
    `${framework}: ${bucket.programs} programs, ${bucket.intents} routes, ` +
      `${bucket.claimed} claimed, ${bucket.abstained} abstained (${(rate * 100).toFixed(1)}%), ` +
      `falseClaims ${bucket.falseClaims}, uncovered ${bucket.uncovered}, ` +
      `harness failures ${bucket.harnessFailures}`,
  );
}
const abstentionRate =
  totals.intents > 0 ? totals.abstained / totals.intents : 0;
console.log(
  `total: ${totals.programs} programs in ${seconds.toFixed(1)}s, ` +
    `${totals.intents} routes, falseClaim count ${totals.falseClaims}, ` +
    `uncovered ${totals.uncovered}, harness failures ${totals.harnessFailures}, ` +
    `abstention rate ${totals.abstained}/${totals.intents} (${(abstentionRate * 100).toFixed(1)}%)`,
);

if (failingPrograms > 0) {
  console.error(
    `\n${failingPrograms} program(s) failed adjudication, see above`,
  );
  process.exit(1);
}
console.log("no false claims, nothing uncovered");
