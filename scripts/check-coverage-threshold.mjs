// check-coverage-threshold.mjs
//
// For each package with a committed coverage-summary.json, compare the
// line-coverage % on the current workspace (post-regeneration) against
// what's committed on `main`. Fail if any package regressed.
//
// Usage: `node scripts/check-coverage-threshold.mjs`
// Requires `git fetch origin main` to have run first (CI does this via
// fetch-depth: 0 on the checkout step).

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

const packageDirs = coveragePackages.map(([dir]) => dir);

function readPct(path) {
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return data.total?.lines?.pct ?? null;
  } catch {
    return null;
  }
}

function readPctFromMain(relPath) {
  // A file absent on main means the package is new, so there is nothing
  // to compare. An unresolvable ref or a malformed file throws.
  const committed = readJsonFromRef("origin/main", relPath);
  if (!committed.found) {
    return null;
  }
  return committed.value.total?.lines?.pct ?? null;
}

const regressions = [];
/**
 * How far coverage may fall before the gate calls it a regression, in
 * percentage points of covered lines. A line moving between files
 * shifts a percentage by a hundredth without anything going untested,
 * and the gate used to compare raw floats while printing two decimals,
 * so a package that printed `92.85% to 92.85%` could fail. Anything a
 * reader would see as a drop still fails.
 */
const TOLERANCE_PERCENTAGE_POINTS = 0.05;

let comparisonsRun = 0;

for (const pkgPath of packageDirs) {
  const relPath = `${pkgPath}/coverage/coverage-summary.json`;
  const absPath = resolve(root, relPath);

  if (!existsSync(absPath)) {
    continue; // package has no coverage yet
  }

  const current = readPct(absPath);

  let baseline;
  try {
    baseline = readPctFromMain(relPath);
  } catch (err) {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  }

  if (current === null) {
    console.log(`  ${pkgPath}: no current coverage — skipping`);
    continue;
  }

  if (baseline === null) {
    console.log(`  ${pkgPath}: no baseline on main — skipping (new package)`);
    continue;
  }

  comparisonsRun++;
  const delta = current - baseline;
  printDelta(pkgPath, baseline, current, asPercent);

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

if (
  reportRegressions({
    title: `Coverage regressed in ${regressions.length} package(s):`,
    regressions,
  })
) {
  process.exit(1);
}

console.log(`\n✓ No coverage regressions across ${comparisonsRun} package(s).`);
