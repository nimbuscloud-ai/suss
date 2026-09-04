/**
 * The single-answer policy shared by every question shaped `[key,
 * answer]`, such as `wantedIsWrittenAs` or `wantedSubjectWritten`. The
 * README's subject section says why a call asked about directly needs
 * its match against itself dropped first.
 */

import type { Tuple } from "@suss/datalog";

/** The one answer each key settles on, once a key's match against itself is dropped. */
export function singleAnswers(rows: Iterable<Tuple>): Map<string, string> {
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

  const settled = new Map<string, string>();
  for (const [key, set] of candidates) {
    if (set.size === 1) {
      settled.set(key, [...set][0] as string);
    }
  }
  return settled;
}
