// checkCoverageBaseline.mjs
//
// Compare the line coverage a fresh test run produced against the
// coverage-summary.json files committed in the tree it ran on, and fail
// when a package came out below the number its author committed.
//
// The comparison is against `HEAD`, the same ref checkDogfoodBaseline.mjs
// uses, and for the same reason. Against `origin/main` the gate asks two
// questions at once: did this branch lower coverage, and has main moved
// since the branch forked. Only the first is worth failing a build over,
// and the second fails branches that touched nothing, because every
// merge moves main under them. Against `HEAD` the question is the one
// that matters: does this tree hold up the numbers its author committed.
//
// Committed coverage is a floor. A change that raises coverage needs no
// refresh. An author who lowers it runs `npm run test:badges` and commits
// the new figure, and the drop lands in the pull request diff where a
// reviewer can read it and agree it should have.
//
// Usage: `node scripts/checkCoverageBaseline.mjs`, after
// `npm run test:coverage` and `npm run badges`. Set
// COVERAGE_BASELINE_REF to compare against some other ref.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  asPercent,
  printDelta,
  readJsonFromRef,
  reportRegressions,
} from "./baselineCompare.mjs";
import { coveragePackages } from "./coverage-packages.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const BASELINE_REF = process.env.COVERAGE_BASELINE_REF ?? "HEAD";

/**
 * How far coverage may fall before the gate calls it a regression, in
 * percentage points of covered lines. A line moving between files
 * shifts a percentage by a hundredth without anything going untested,
 * and the gate used to compare raw floats while printing two decimals,
 * so a package that printed `92.85% to 92.85%` could fail. Anything a
 * reader would see as a drop still fails.
 */
const TOLERANCE_PERCENTAGE_POINTS = 0.05;

function linePercentOf(summary) {
  return summary.total?.lines?.pct ?? null;
}

function currentPercent(absPath) {
  try {
    return linePercentOf(JSON.parse(readFileSync(absPath, "utf8")));
  } catch {
    return null;
  }
}

function committedPercent(relPath) {
  // A file absent on the ref means the package is new, so there is
  // nothing to compare. An unresolvable ref or a malformed file throws.
  const committed = readJsonFromRef(BASELINE_REF, relPath);
  if (!committed.found) {
    return null;
  }
  return linePercentOf(committed.value);
}

const regressions = [];
let comparisonsRun = 0;

console.log(`Line coverage against ${BASELINE_REF}:`);

for (const [pkgPath] of coveragePackages) {
  const relPath = `${pkgPath}/coverage/coverage-summary.json`;
  const absPath = resolve(root, relPath);

  if (!existsSync(absPath)) {
    continue; // package has no coverage yet
  }

  const current = currentPercent(absPath);

  let baseline;
  try {
    baseline = committedPercent(relPath);
  } catch (err) {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  }

  if (current === null) {
    console.log(`  ${pkgPath}: no current coverage, nothing to compare`);
    continue;
  }

  if (baseline === null) {
    console.log(
      `  ${pkgPath}: new since ${BASELINE_REF}, no baseline to compare`,
    );
    continue;
  }

  comparisonsRun++;
  printDelta(pkgPath, baseline, current, asPercent);

  const delta = current - baseline;
  if (delta < -TOLERANCE_PERCENTAGE_POINTS) {
    regressions.push({
      label: pkgPath,
      detail: `${asPercent(baseline)} → ${asPercent(current)} (${delta.toFixed(2)})`,
    });
  }
}

if (comparisonsRun === 0) {
  console.log("No packages to compare.");
  process.exit(0);
}

const failed = reportRegressions({
  title: `Coverage came out below what ${BASELINE_REF} commits in ${regressions.length} package(s):`,
  regressions,
  hint: "Either a test stopped covering code it used to cover, or covered code was deleted. If the drop was meant, run `npm run test:badges` and commit the refreshed coverage summaries and badges on this branch. The drop then lands in the pull request diff, where a reviewer can see what went and agree it should have.",
});

if (failed) {
  process.exit(1);
}

console.log(
  `\n✓ No coverage regressions against ${BASELINE_REF} across ${comparisonsRun} package(s).`,
);
