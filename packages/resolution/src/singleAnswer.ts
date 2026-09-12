/**
 * What counts as an answer to a question shaped `[key, answer]`, such as
 * `wantedIsWrittenAs` or `wantedSubjectWritten`. A call is written as
 * itself, so a call asked about directly always matches its own key; that
 * row is dropped before the count so one other answer settles it instead
 * of counting as two.
 *
 * A placeholder write, `client = None` before a guard fills it in, is
 * set aside the same way when the key has any other answer. A key
 * written only as a placeholder keeps it.
 *
 * A caller that can only use one answer takes `singleAnswers`; one with
 * something to say about a value written two ways takes `answersByKey`.
 */

import type { Database, Tuple } from "@suss/datalog";

const NO_PLACEHOLDERS: ReadonlySet<string> = new Set();

/** Every answer each key has, in the order the rows arrive, with the two drops above applied. */
export function answersByKey(
  rows: Iterable<Tuple>,
  placeholders: ReadonlySet<string> = NO_PLACEHOLDERS,
): Map<string, string[]> {
  const candidates = new Map<string, Set<string>>();
  for (const row of rows) {
    const key = String(row[0]);
    const answer = String(row[1]);
    if (answer === key) {
      continue;
    }
    const set = candidates.get(key) ?? new Set<string>();
    set.add(answer);
    candidates.set(key, set);
  }

  const answers = new Map<string, string[]>();
  for (const [key, set] of candidates) {
    answers.set(key, withoutPlaceholders(set, placeholders));
  }
  return answers;
}

/** The one answer each key settles on, for a caller that treats several as none. */
export function singleAnswers(
  rows: Iterable<Tuple>,
  placeholders: ReadonlySet<string> = NO_PLACEHOLDERS,
): Map<string, string> {
  const settled = new Map<string, string>();
  for (const [key, answers] of answersByKey(rows, placeholders)) {
    if (answers.length === 1) {
      settled.set(key, answers[0] as string);
    }
  }
  return settled;
}

/** The keys an adapter marked `placeholderValue`, for passing to `singleAnswers`. */
export function placeholderValues(db: Database): ReadonlySet<string> {
  return new Set(db.facts("placeholderValue").map((row) => String(row[0])));
}

function withoutPlaceholders(
  answers: ReadonlySet<string>,
  placeholders: ReadonlySet<string>,
): string[] {
  const kept = [...answers].filter((answer) => !placeholders.has(answer));
  if (kept.length === 0) {
    return [...answers];
  }
  return kept;
}
