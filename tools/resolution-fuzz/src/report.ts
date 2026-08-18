/**
 * What a failing run prints.
 *
 * The committed file keeps a digest, so a base that moved has to be
 * explained here rather than read out of the diff: the facts that
 * produced it and every answer they now derive. A rule change usually
 * moves hundreds of bases at once, so only the first few are printed in
 * full and the rest are listed by number.
 */

import { QUESTIONS } from "./answers.js";
import { BASELINE_NAME, caseLine, readCaseLine } from "./baselineFile.js";
import { factBase } from "./factBases.js";

import type { Answers } from "./answers.js";
import type { Baseline, Sweep } from "./baselineFile.js";

/** How many moved bases get their facts and answers printed. */
const EXPLAINED = 3;

const arrow = (before: number, after: number): string =>
  `${before} → ${after} (${after >= before ? "↑" : "↓"}${Math.abs(after - before)})`;

const fact = (relation: string, ...atoms: readonly string[]): string =>
  `${relation}(${atoms.join(", ")})`;

/** Every count that differs between one committed line and a fresh one. */
function movedFields(before: string, after: string): string[] {
  const was = readCaseLine(before);
  const now = readCaseLine(after);
  return Object.keys(now)
    .filter((field) => field !== "base" && was[field] !== now[field])
    .map((field) =>
      field === "digest"
        ? `digest ${was[field]} → ${now[field]}`
        : `${field} ${arrow(Number(was[field]), Number(now[field]))}`,
    );
}

function explain(seed: number, answers: Answers, committed: string): string[] {
  const lines = [
    `  base ${answers.index}: ${movedFields(committed, caseLine(answers)).join(", ")}`,
    "    facts:",
    ...factBase(seed, answers.index).facts.map(
      ([relation, ...atoms]) => `      ${fact(relation, ...atoms)}`,
    ),
  ];
  for (const question of QUESTIONS) {
    const tuples = answers.tuples[question];
    if (tuples.length > 0) {
      lines.push(`    ${question}:`, ...tuples.map((t) => `      ${t}`));
    }
  }
  return lines;
}

export interface Moved {
  readonly answers: Answers;
  readonly committed: string;
}

/** The whole message, from the totals down to the bases worth reading. */
export function movedReport(
  seed: number,
  baseline: Baseline,
  fresh: Baseline,
  moved: readonly Moved[],
): string {
  const lines = [
    `The resolution rules answer differently than ${BASELINE_NAME} says.`,
    "",
    `${moved.length} of ${fresh.bases} generated fact bases moved. Totals:`,
    ...QUESTIONS.filter(
      (question) => baseline.totals[question] !== fresh.totals[question],
    ).map(
      (question) =>
        `  ${question}: ${arrow(baseline.totals[question] ?? 0, fresh.totals[question] ?? 0)}`,
    ),
    "",
  ];

  for (const { answers, committed } of moved.slice(0, EXPLAINED)) {
    lines.push(...explain(seed, answers, committed), "");
  }

  const rest = moved.slice(EXPLAINED);
  if (rest.length > 0) {
    lines.push(
      `and ${rest.length} more: ${rest
        .slice(0, 40)
        .map(({ answers }) => answers.index)
        .join(", ")}${rest.length > 40 ? ", ..." : ""}`,
      "",
    );
  }

  lines.push(
    "If the rules were meant to change, run `npm run resolution:baseline` and commit the",
    "refreshed file. The counts land in the pull request diff, where a reviewer reads",
    "what a rule started or stopped deriving.",
  );
  return lines.join("\n");
}

/**
 * The message for a sweep whose digest moved while every committed line
 * held. Something changed past the five hundredth base, and the totals
 * are what says which question and which way.
 */
export const sweepReport = (baseline: Baseline, sweep: Sweep): string =>
  [
    `The wider sweep derives something ${BASELINE_NAME} does not have written down.`,
    `  digest: ${baseline.sweep.digest} → ${sweep.digest}`,
    ...QUESTIONS.filter(
      (question) => baseline.sweep.totals[question] !== sweep.totals[question],
    ).map(
      (question) =>
        `  ${question}: ${arrow(baseline.sweep.totals[question] ?? 0, sweep.totals[question] ?? 0)}`,
    ),
    "",
    `Every committed line held, so whatever moved is past base ${baseline.bases}.`,
    "`RESOLUTION_LINES=<n> npm run resolution:baseline` writes a line per base for the",
    "first n of them, which says which base moved; accept it with the plain command.",
  ].join("\n");

/** The message for a run that generated a different number of bases. */
export const headerReport = (baseline: Baseline, fresh: Baseline): string =>
  [
    `${BASELINE_NAME} was written for a different run than this one.`,
    `  seed: ${baseline.seed} → ${fresh.seed}`,
    `  questions: ${baseline.questions.join(", ")} → ${fresh.questions.join(", ")}`,
    "",
    "Changing the generator or the seed regenerates every line, so run",
    "`npm run resolution:baseline` and let the diff show what that cost.",
  ].join("\n");
