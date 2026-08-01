// checkDogfoodBaseline.mjs
//
// Compare the counts a fresh dogfood run produced against the counts
// committed in the tree it ran on, and fail when a number went down
// without anyone saying it should.
//
// The comparison is against `HEAD`, not against main. The corpus being
// counted is this repo's own source, so comparing against main asks two
// questions at once: did suss get worse, and did we change our code.
// Only the first is worth failing a build over. Against `HEAD`, the
// question is the one that matters: does the tree produce the counts its
// author said it would. Deleting an export lowers a count, and the
// author lowers the committed baseline in the same commit, where the
// delta against main lands in the pull request diff for a person to
// read. Nobody can lower it without that showing up.
//
// Counts only ever act as a floor. Adding an export raises the number
// and needs no baseline refresh; CI on main pushes the refreshed file
// back so the floor keeps up with the source.
//
// What the invariants in dogfoodInvariants.mjs cannot see is a
// recognizer that stops firing at some call sites while still firing at
// others. Every declared export still has a summary, every boundary
// still has a key, and the count is the only thing that moved. That is
// most of what a dogfood run measures: 753 of today's 949 provider
// summaries come from the transitive closure, and no invariant counts
// those. So the counts stay a hard failure, with a way to declare a drop
// rather than a tolerance that guesses at one.
//
// Usage: `node scripts/checkDogfoodBaseline.mjs`, after
// `node scripts/dogfood.mjs`. Set DOGFOOD_BASELINE_REF to compare
// against some other ref.

import { existsSync, readFileSync } from "node:fs";

import {
  printDelta,
  readJsonFromRef,
  reportRegressions,
} from "./baselineCompare.mjs";
import { BASELINE_PATH, BASELINE_REL_PATH } from "./dogfoodOutputs.mjs";

const BASELINE_REF = process.env.DOGFOOD_BASELINE_REF ?? "HEAD";

if (!existsSync(BASELINE_PATH)) {
  console.error(
    `✗ ${BASELINE_REL_PATH} is missing. Run \`npm run dogfood\` first.`,
  );
  process.exit(1);
}

const current = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));

let committed;
try {
  committed = readJsonFromRef(BASELINE_REF, BASELINE_REL_PATH);
} catch (err) {
  console.error(`✗ ${err.message}`);
  process.exit(1);
}

if (!committed.found) {
  console.log(
    `No dogfood baseline on ${BASELINE_REF}, so there is nothing to compare against.`,
  );
  process.exit(0);
}

const baseline = committed.value;
const regressions = [];

/** Print the line, and record it when the number fell. */
function compareFloor(label, before, after) {
  printDelta(label, before, after);
  if (after < before) {
    regressions.push({ label, detail: `${before} → ${after}` });
  }
}

console.log(`Totals against ${BASELINE_REF}:`);
for (const field of Object.keys(baseline.totals)) {
  compareFloor(field, baseline.totals[field], current.totals[field]);
}

console.log("\nPer package:");
for (const [dir, before] of Object.entries(baseline.packages)) {
  const after = current.packages[dir];

  if (after === undefined) {
    console.log(`  ${dir}: gone from the workspace, nothing to compare`);
    continue;
  }

  const label =
    after.name === before.name
      ? after.name
      : `${dir} (${before.name} → ${after.name})`;
  compareFloor(`${label} providers`, before.providers, after.providers);
  compareFloor(`${label} consumers`, before.consumers, after.consumers);
}

for (const dir of Object.keys(current.packages)) {
  if (baseline.packages[dir] === undefined) {
    console.log(`  ${dir}: new since ${BASELINE_REF}, no baseline to compare`);
  }
}

const failed = reportRegressions({
  title: `suss sees less of this tree than ${BASELINE_REL_PATH} says it should:`,
  regressions,
  hint: `Either a recognizer stopped firing, or the code these counted was deleted. If it was deleted, run \`npm run dogfood\` and commit the refreshed ${BASELINE_REL_PATH} on this branch. The drop then lands in the pull request diff, where a reviewer can see what went and agree it should have.`,
});

if (failed) {
  process.exit(1);
}

console.log(`\n✓ No dogfood coverage regressions against ${BASELINE_REF}.`);
