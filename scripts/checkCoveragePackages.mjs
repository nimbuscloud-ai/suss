#!/usr/bin/env node
// checkCoveragePackages.mjs: every package this repo publishes has to be
// under the coverage gate.
//
// The badge generator and the regression gate both read
// scripts/coverage-packages.mjs. A package missing from that list gets no
// badge and no baseline, so its coverage can be zero, or fall to
// zero, without failing anything. Four packages shipped that way for
// months before this check existed, and nothing in the build would have
// said so.
//
// Publishable means what preparePublish.mjs means by it: a package.json
// under packages/, found by the walk both scripts share. A manifest
// carrying `private: true` is skipped here, though preparePublish will
// object to it separately, since under packages/ everything ships.
//
// The package table in docs/reference/packages.md is the same kind of
// hand-kept list against the same workspace, so it is checked here too:
// a package readers cannot find is a milder version of the same
// omission.
//
// Usage: `node scripts/checkCoveragePackages.mjs`

import fs from "node:fs";
import path from "node:path";

import { coveragePackages } from "./coverage-packages.mjs";
import { ROOT, readWorkspacePackages } from "./workspacePackages.mjs";

/**
 * Packages that ship but stay out of the coverage list, and the reason
 * each one is out. An entry here is a decision somebody wrote down; a
 * package simply missing from coverage-packages.mjs is not.
 *
 * Empty today. Every package under packages/ has a src/ and a
 * test:coverage script, so every one of them can be measured. A package
 * that genuinely cannot be (a re-export shim with no code of its own,
 * say) belongs here with a sentence saying why, not left off the list.
 */
const EXEMPT = new Map([
  // ["packages/example", "why this one cannot be measured"],
  [
    "packages/packs",
    "every file re-exports one pack and nothing else, so the packs' own tests are the coverage",
  ],
]);

const listedDirs = new Map(coveragePackages);
const workspace = readWorkspacePackages();
const problems = [];

for (const pkg of workspace) {
  if (pkg.isPrivate) {
    continue;
  }

  const exemption = EXEMPT.get(pkg.dir);
  if (exemption !== undefined) {
    if (listedDirs.has(pkg.dir)) {
      problems.push(
        `${pkg.dir} is both exempt and in the coverage list. Drop the EXEMPT entry in scripts/checkCoveragePackages.mjs.`,
      );
    }
    continue;
  }

  if (!listedDirs.has(pkg.dir)) {
    problems.push(
      `${pkg.dir} (${pkg.name}) publishes but is missing from scripts/coverage-packages.mjs, so it has no badge and no coverage baseline.`,
    );
    continue;
  }

  if (!pkg.hasCoverageScript) {
    problems.push(
      `${pkg.dir} is in the coverage list but declares no test:coverage script, so it will never produce a summary to gate on.`,
    );
  }
}

const workspaceDirs = new Set(workspace.map((pkg) => pkg.dir));

for (const dir of listedDirs.keys()) {
  if (!workspaceDirs.has(dir)) {
    problems.push(
      `${dir} is in scripts/coverage-packages.mjs but no longer exists. Remove the entry and its badge.`,
    );
  }
}

for (const dir of EXEMPT.keys()) {
  if (!workspaceDirs.has(dir)) {
    problems.push(
      `${dir} is exempt in scripts/checkCoveragePackages.mjs but no longer exists. Remove the EXEMPT entry.`,
    );
  }
}

// Two packages sharing a badge slug would overwrite each other's SVG,
// and the second one written would silently stand in for both.
const slugOwners = new Map();
for (const [dir, slug] of coveragePackages) {
  const owner = slugOwners.get(slug);
  if (owner !== undefined) {
    problems.push(
      `${dir} and ${owner} share the badge slug "${slug}", so they would write the same badge file.`,
    );
  }
  slugOwners.set(slug, dir);
}

const DOCS_TABLE = path.join(ROOT, "docs", "reference", "packages.md");
const docsTable = fs.readFileSync(DOCS_TABLE, "utf8");

for (const pkg of workspace) {
  if (pkg.isPrivate || docsTable.includes(`](../../${pkg.dir})`)) {
    continue;
  }
  problems.push(
    `${pkg.name} has no row in docs/reference/packages.md, so nobody reading the docs knows it exists.`,
  );
}

for (const [dir, slug] of coveragePackages) {
  if (docsTable.includes(`coverage-${slug}.svg`)) {
    continue;
  }
  problems.push(
    `${dir} has a badge at .github/badges/coverage-${slug}.svg that docs/reference/packages.md never shows.`,
  );
}

// A doc that says how many packages this repo ships goes stale the
// moment somebody adds one, and nothing about the addition points at the
// sentence. These are the docs that describe the workspace as it stands.
// pack-health.md stays out entirely: every number in it is a row of what
// one run measured, and correcting one would falsify it.
const COUNT_CLAIMS = [
  "CONTRIBUTING.md",
  "docs/internal/releasing.md",
  "docs/internal/dogfooding.md",
];

/**
 * Sentences in those docs that count something a past run saw, rather
 * than what the workspace holds now. Each is exempt for the same reason
 * pack-health.md is: raising the number would change what was measured
 * into something nobody measured.
 *
 * Each pattern matches the shape of the record it protects, not words
 * that appear in it. A phrase a later sentence could reuse would give
 * the exemption to that sentence and hide a stale count inside it.
 */
const MEASURED_IN_THE_PAST = [
  // One release's failure, named by the error code it reported.
  /`ENEEDAUTH` on all 34 packages/,
  // One dogfood run's totals: three counts, then the fraction of
  // packages it read.
  /\d+ export \+ \d+ internal \+ \d+ consumer summaries across \d+\/\d+/,
];

const publishedCount = workspace.filter((pkg) => !pkg.isPrivate).length;

for (const doc of COUNT_CLAIMS) {
  const text = fs.readFileSync(path.join(ROOT, doc), "utf8");
  for (const [index, line] of text.split("\n").entries()) {
    const scannable = MEASURED_IN_THE_PAST.reduce(
      (rest, record) => rest.replace(record, ""),
      line,
    );

    for (const match of scannable.matchAll(
      /\b(\d+) (?:`@suss\/\*` )?packages\b/g,
    )) {
      if (Number(match[1]) === publishedCount) {
        continue;
      }
      problems.push(
        `${doc}:${index + 1} says ${match[1]} packages, but this repo ships ${publishedCount}.`,
      );
    }
  }
}

if (problems.length > 0) {
  process.stderr.write(
    `\n✗ ${problems.length} coverage-list ${problems.length === 1 ? "problem" : "problems"}:\n`,
  );
  for (const problem of problems) {
    process.stderr.write(`  ${problem}\n`);
  }
  process.stderr.write(
    "\nAdd each package to scripts/coverage-packages.mjs as [dir, badgeSlug], give it a row in docs/reference/packages.md, run \`npm run test:badges\`, and commit the badge. If a package cannot be measured at all, add it to EXEMPT in scripts/checkCoveragePackages.mjs with a reason.\n",
  );
  process.exit(1);
}

// A listed package with no committed summary has never had its badge
// generated from a run. That is a warning rather than a failure: a fresh
// clone that has not run tests yet is in exactly that state.
const missingSummaries = coveragePackages
  .map(([dir]) => dir)
  .filter(
    (dir) =>
      !fs.existsSync(path.join(ROOT, dir, "coverage", "coverage-summary.json")),
  );

for (const dir of missingSummaries) {
  process.stdout.write(`  ${dir}: no coverage summary yet\n`);
}

const exemptNote =
  EXEMPT.size > 0 ? `, ${EXEMPT.size} exempt by name` : ", none exempt";
process.stdout.write(
  `✓ All ${listedDirs.size} publishable packages are under the coverage gate${exemptNote}.\n`,
);
