// baselineCompare.mjs
//
// The shape both regression gates share: read a committed JSON file out
// of a git ref, print a before/after line for every number compared, and
// exit non-zero listing whatever went backwards. The coverage gate and
// the dogfood gate each had their own copy, and the copies had already
// drifted on the one question that matters, which is what to do when the
// read fails.
//
// A ref that does not resolve and a file that is malformed are bugs in
// how the gate was invoked. A file that is absent on the ref means the
// thing being measured is new, and skipping it is correct. Swallowing
// all three alike lets a gate pass by doing nothing.

import { execSync } from "node:child_process";

function git(args) {
  return execSync(`git ${args}`, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/**
 * Read `<ref>:<relPath>` and parse it. Returns `{ found: false }` when
 * the ref resolves but does not carry that path. Throws when the ref
 * does not resolve or the file does not parse.
 */
export function readJsonFromRef(ref, relPath) {
  try {
    git(`rev-parse --verify --quiet ${ref}^{commit}`);
  } catch {
    throw new Error(
      `Cannot resolve ${ref}, so there is nothing to compare against. CI checks out with fetch-depth: 0, which is what makes remote refs available; locally you may need to fetch first.`,
    );
  }

  let raw;
  try {
    raw = git(`show ${ref}:${relPath}`);
  } catch {
    return { found: false };
  }

  try {
    return { found: true, value: JSON.parse(raw) };
  } catch (err) {
    throw new Error(`${relPath} on ${ref} is not valid JSON: ${err.message}`);
  }
}

/** A whole number, for counts of things suss saw. */
export const asCount = (n) => String(n);

/** A percentage to two places, for line coverage. */
export const asPercent = (n) => `${n.toFixed(2)}%`;

/** `label: 157 → 26 (↓131)`, the line every comparison prints. */
export function printDelta(label, before, after, format = asCount) {
  const delta = after - before;
  const arrow = delta >= 0 ? "↑" : "↓";
  console.log(
    `  ${label}: ${format(before)} → ${format(after)} (${arrow}${format(Math.abs(delta))})`,
  );
}

/**
 * Print the collected regressions and say whether there were any, so the
 * caller can exit on the answer. Each regression carries its own reason
 * because the two gates fail for different sorts of reasons.
 */
export function reportRegressions({ title, regressions, hint }) {
  if (regressions.length === 0) {
    return false;
  }

  console.error(`\n✗ ${title}`);
  for (const r of regressions) {
    console.error(`  ${r.label}: ${r.detail}`);
  }
  if (hint) {
    console.error(`\n${hint}`);
  }
  return true;
}
