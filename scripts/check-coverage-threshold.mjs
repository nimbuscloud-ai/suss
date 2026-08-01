// check-coverage-threshold.mjs
//
// For each package with a committed coverage-summary.json, compare the
// line-coverage % on the current workspace (post-regeneration) against
// what's committed on `main`. Fail if any package regressed.
//
// Usage: `node scripts/check-coverage-threshold.mjs`
// Requires `git fetch origin main` to have run first (CI does this via
// fetch-depth: 0 on the checkout step).

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  // `git show origin/main:<path>` — if the file doesn't exist on main
  // (new package), return null so we skip the comparison.
  try {
    const content = execSync(`git show origin/main:${relPath}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const data = JSON.parse(content);
    return data.total?.lines?.pct ?? null;
  } catch {
    return null;
  }
}

const regressions = [];
/**
 * How far coverage may fall before the gate calls it a regression.
 * A line moving between files shifts a percentage by a hundredth
 * without anything going untested, and the gate used to compare raw
 * floats while printing two decimals, so a package that printed
 * `92.85% to 92.85%` could fail. Anything a reader would see as a drop
 * still fails.
 */
const TOLERANCE = 0.05;

let comparisonsRun = 0;

for (const pkgPath of packageDirs) {
  const relPath = `${pkgPath}/coverage/coverage-summary.json`;
  const absPath = resolve(root, relPath);

  if (!existsSync(absPath)) {
    continue; // package has no coverage yet
  }

  const current = readPct(absPath);
  const baseline = readPctFromMain(relPath);

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
  const arrow = delta >= 0 ? "↑" : "↓";
  console.log(
    `  ${pkgPath}: ${baseline}% → ${current}% (${arrow}${Math.abs(delta).toFixed(2)}%)`,
  );

  if (delta < -TOLERANCE) {
    regressions.push({ pkgPath, baseline, current, delta });
  }
}

if (comparisonsRun === 0) {
  console.log("No packages to compare.");
  process.exit(0);
}

if (regressions.length > 0) {
  console.error(`\n✗ Coverage regressed in ${regressions.length} package(s):`);
  for (const r of regressions) {
    console.error(
      `  ${r.pkgPath}: ${r.baseline}% → ${r.current}% (${r.delta.toFixed(2)}%)`,
    );
  }
  process.exit(1);
}

console.log(`\n✓ No coverage regressions across ${comparisonsRun} package(s).`);
