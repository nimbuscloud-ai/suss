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
// most of what a dogfood run measures: 785 of today's 987 library
// summaries are behind the export surface, reached by the transitive
// closure, and no invariant counts those. So the counts stay a hard
// failure, with a way to declare a drop rather than a tolerance that
// guesses at one.
//
// This is also why the internal count is compared and not only printed.
// A closure that stops expanding leaves every declared export summarised
// and every invariant passing, and the internal line is the only place
// it shows up.
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

/**
 * Print the line, and record it when the number fell or stopped being
 * produced at all.
 *
 * The two ways a number can be missing are not the same thing. A
 * baseline without the field was written before the field
 * existed, and there is nothing to compare; that is the only case worth
 * passing over, and it is a migration affordance that can go once no
 * open branch predates the field. A baseline that has the field
 * while the run no longer produces it means whatever computed that count
 * stopped working, which the gate has to fail on for the same reason it
 * fails on a drop.
 */
function compareFloor(label, before, after, allowance = 0) {
  if (typeof before !== "number") {
    return;
  }
  if (typeof after !== "number") {
    console.log(`  ${label}: ${before} → missing`);
    regressions.push({
      label,
      detail: `${before} on ${BASELINE_REF}, and this run produced no such count`,
    });
    return;
  }
  printDelta(label, before, after);
  if (after < before - allowance) {
    regressions.push({
      label,
      detail:
        allowance > 0
          ? `${before} → ${after}, and only ${allowance} of that became a consumer`
          : `${before} → ${after}`,
    });
  }
}

/**
 * The same, for a count of what suss could not see. `unfollowedCalls`
 * says how many calls the walk stopped at, so it is the one number the
 * gate wants to stay down: a rise means the run followed less of the
 * same source than the tree says it should.
 */
function compareCeiling(label, before, after) {
  if (typeof before !== "number") {
    return;
  }
  if (typeof after !== "number") {
    console.log(`  ${label}: ${before} → missing`);
    regressions.push({
      label,
      detail: `${before} on ${BASELINE_REF}, and this run produced no such count`,
    });
    return;
  }
  printDelta(label, before, after);
  if (after > before) {
    regressions.push({ label, detail: `${before} → ${after}` });
  }
}

/** Which way each count is allowed to move. Floor unless listed here. */
const CEILINGS = new Set(["unfollowedCalls"]);

/**
 * How many units moved from the internal column to the consumer one.
 *
 * A function that starts calling into another package stops being only
 * an internal helper and becomes a consumer too, so one count falls as
 * the other rises and neither is a regression. Only the part of the
 * drop the rise accounts for is a move: a drop of three against a rise
 * of two leaves one unit that really did stop being seen (#324).
 */
function movedToConsumers(before, after) {
  if (
    typeof before?.internal !== "number" ||
    typeof after?.internal !== "number" ||
    typeof before?.consumers !== "number" ||
    typeof after?.consumers !== "number"
  ) {
    return 0;
  }
  const drop = Math.max(0, before.internal - after.internal);
  const rise = Math.max(0, after.consumers - before.consumers);
  return Math.min(drop, rise);
}

/** Compare one count, saying so when the baseline has never seen it. */
function compareField(field, label, before, after, allowance = 0) {
  if (before === undefined && typeof after === "number") {
    console.log(
      `  ${label}: ${after}, new since ${BASELINE_REF}, no baseline to compare`,
    );
    return;
  }
  if (CEILINGS.has(field)) {
    compareCeiling(label, before, after);
    return;
  }
  compareFloor(label, before, after, allowance);
}

/** The counts this file knows about, in the order they read best. */
const FIELD_ORDER = [
  "packages",
  "packagesWithExports",
  "exports",
  "internal",
  "consumers",
  "pairs",
  "unfollowedCalls",
];

/**
 * The counts to compare on a pair of records.
 *
 * Taken from both sides rather than from a fixed list, so a count added
 * to a run gets compared from the next baseline on, and a count that
 * stops being produced is reported rather than dropping out of the loop.
 * A count neither side has a name for prints last.
 */
function countedFields(before, after) {
  const found = new Set(
    [...Object.keys(before), ...Object.keys(after)].filter(
      (field) => field !== "name",
    ),
  );
  return [
    ...FIELD_ORDER.filter((field) => found.has(field)),
    ...[...found].filter((field) => !FIELD_ORDER.includes(field)),
  ];
}

console.log(`Totals against ${BASELINE_REF}:`);
const totalsMoved = movedToConsumers(baseline.totals, current.totals);
if (totalsMoved > 0) {
  console.log(
    `  ${totalsMoved} unit${totalsMoved === 1 ? "" : "s"} moved from internal to consumers`,
  );
}
for (const field of countedFields(baseline.totals, current.totals)) {
  compareField(
    field,
    field,
    baseline.totals[field],
    current.totals[field],
    field === "internal" ? totalsMoved : 0,
  );
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
  const moved = movedToConsumers(before, after);
  if (moved > 0) {
    console.log(
      `  ${label}: ${moved} unit${moved === 1 ? "" : "s"} moved from internal to consumers`,
    );
  }
  for (const field of countedFields(before, after)) {
    compareField(
      field,
      `${label} ${field}`,
      before[field],
      after[field],
      field === "internal" ? moved : 0,
    );
  }
}

for (const dir of Object.keys(current.packages)) {
  if (baseline.packages[dir] === undefined) {
    console.log(`  ${dir}: new since ${BASELINE_REF}, no baseline to compare`);
  }
}

const failed = reportRegressions({
  title: `suss sees less of this tree than ${BASELINE_REL_PATH} says it should:`,
  regressions,
  hint: `Either a recognizer stopped firing, or the code these counted was deleted. If it was deleted, run \`npm run dogfood\` and commit the refreshed ${BASELINE_REL_PATH} on this branch. The drop then lands in the pull request diff, where a reviewer can see what went and agree it should have. A count reported as missing rather than lower means the run no longer produces a number the baseline has, which is either the same refresh or a bug in what computes it. \`unfollowedCalls\` is the one count that fails on a rise instead: new code that reaches something through indirection raises it, and the same refresh declares that.`,
});

if (failed) {
  process.exit(1);
}

console.log(`\n✓ No dogfood coverage regressions against ${BASELINE_REF}.`);
