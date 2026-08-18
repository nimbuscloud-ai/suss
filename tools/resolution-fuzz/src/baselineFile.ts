/**
 * The committed answers, and the one line per base they are written as.
 *
 * A base gets one line so that a rule change shows up as one changed
 * line per base it moved, which is what makes the diff the thing a
 * reviewer reads. The line includes the counts as well as the digest,
 * because the counts say which way a base moved without anyone
 * rerunning the harness.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { QUESTIONS } from "./answers.js";

import type { Answers, Question } from "./answers.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Where the committed answers live, and what to call it in a message. */
export const BASELINE_PATH = path.join(HERE, "..", "answers-baseline.json");
export const BASELINE_NAME = "tools/resolution-fuzz/answers-baseline.json";

export interface Sweep {
  readonly bases: number;
  /** One digest over every line the sweep produces, committed as a line. */
  readonly digest: string;
  readonly totals: Readonly<Record<string, number>>;
}

export interface Baseline {
  readonly seed: number;
  readonly bases: number;
  readonly questions: readonly string[];
  /** Every tuple of that question, added up over every base. */
  readonly totals: Readonly<Record<string, number>>;
  /** How many bases derived anything at all for that question. */
  readonly reach: Readonly<Record<string, number>>;
  readonly sweep: Sweep;
  readonly cases: readonly string[];
}

const padded = (index: number): string => String(index).padStart(4, "0");

/** `0042 facts=44 comesTo=9 ... digest=6f1c2a9d3e40`. */
export const caseLine = (answers: Answers): string =>
  [
    padded(answers.index),
    `facts=${answers.facts}`,
    ...QUESTIONS.map((question) => `${question}=${answers.counts[question]}`),
    `digest=${answers.digest}`,
  ].join(" ");

/** The fields of a line, for a report that has to say what moved. */
export function readCaseLine(line: string): Record<string, string> {
  const [index = "", ...rest] = line.split(" ");
  const fields: Record<string, string> = { base: index };
  for (const field of rest) {
    const at = field.indexOf("=");
    if (at > 0) {
      fields[field.slice(0, at)] = field.slice(at + 1);
    }
  }
  return fields;
}

const sum = (
  every: readonly Answers[],
  read: (answers: Answers, question: Question) => number,
): Record<string, number> =>
  Object.fromEntries(
    QUESTIONS.map((question) => [
      question,
      every.reduce((total, answers) => total + read(answers, question), 0),
    ]),
  );

const totalsOf = (every: readonly Answers[]): Record<string, number> =>
  sum(every, (answers, question) => answers.counts[question]);

/**
 * One digest over a whole sweep. The bases past the committed lines get
 * this instead of a line each, so widening the sweep from five hundred
 * to four thousand costs the file one line rather than three and a half
 * thousand.
 */
export const sweepOf = (every: readonly Answers[]): Sweep => ({
  bases: every.length,
  digest: createHash("sha256")
    .update(every.map(caseLine).join("\n"))
    .digest("hex")
    .slice(0, 12),
  totals: totalsOf(every),
});

/**
 * The committed file. `every` is the whole sweep; the first `lines` of
 * them are written out one by one and all of them go into the sweep
 * digest.
 */
export function baselineFrom(
  seed: number,
  lines: number,
  every: readonly Answers[],
): Baseline {
  const committed = every.slice(0, lines);
  return {
    seed,
    bases: committed.length,
    questions: [...QUESTIONS],
    totals: totalsOf(committed),
    reach: sum(committed, (answers, question) =>
      answers.counts[question] > 0 ? 1 : 0,
    ),
    sweep: sweepOf(every),
    cases: committed.map(caseLine),
  };
}

export function writeBaseline(baseline: Baseline): void {
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
}

export function readBaseline(): Baseline | null {
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
  } catch {
    return null;
  }
}
