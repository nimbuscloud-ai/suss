// longrun.mjs — exploratory fuzz session (not part of the test suite).
// Runs many random-seed rounds per tier and prints every shrunk
// counterexample, for corpus curation. Usage:
//   node longrun.mjs [tier] [numRuns] [rounds] [target]
// Build first (`npx tsup`) — imports from dist.
import fc from "fast-check";

import {
  ALL_TARGETS,
  arbHandlerProgram,
  arbLoopGuard,
  arbNestedGuard,
  arbProgramWithGapConstruct,
  EXPRESS_TARGET,
  runDifferential,
  SOUND_TIER,
} from "./dist/index.js";

const tierName = process.argv[2] ?? "sound";
const numRuns = Number.parseInt(process.argv[3] ?? "500", 10);
const rounds = Number.parseInt(process.argv[4] ?? "4", 10);
const targetName = process.argv[5] ?? "express";

const arbs = {
  sound: arbHandlerProgram(SOUND_TIER),
  nested: arbProgramWithGapConstruct(arbNestedGuard),
  loop: arbProgramWithGapConstruct(arbLoopGuard),
};
const arb = arbs[tierName];
const target = ALL_TARGETS.find((t) => t.name === targetName) ?? EXPRESS_TARGET;
if (!arb) {
  console.error(`unknown tier ${tierName}`);
  process.exit(1);
}

let found = 0;
for (let round = 0; round < rounds; round++) {
  const seed = Math.floor(Math.random() * 2 ** 31);
  const t0 = performance.now();
  const details = await fc.check(
    fc.asyncProperty(arb, async (program) => {
      const result = await runDifferential(program, target);
      if (result.mismatches.length > 0 || result.harnessFailures.length > 0) {
        throw new Error("counterexample");
      }
    }),
    { numRuns, seed },
  );
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  if (details.failed) {
    found++;
    const program = details.counterexample[0];
    const result = await runDifferential(program, target);
    console.log(
      `\n=== round ${round} seed ${seed} (${secs}s) SHRUNK COUNTEREXAMPLE ===`,
    );
    console.log("program JSON:", JSON.stringify(program));
    console.log(result.moduleSource);
    for (const m of result.mismatches) {
      console.log(`${m.verdict}: ${m.detail}`);
      console.log(`  request: ${JSON.stringify(m.request)}`);
    }
    for (const f of result.harnessFailures) {
      console.log(
        `harness: ${f.message} request: ${JSON.stringify(f.request)}`,
      );
    }
  } else {
    console.log(
      `round ${round} seed ${seed}: clean over ${numRuns} programs (${secs}s) [${target.name}]`,
    );
  }
}
console.log(
  `\n${tierName}/${target.name}: ${found}/${rounds} rounds found counterexamples`,
);
