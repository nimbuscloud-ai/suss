/**
 * Which provider a consumer meant, when several of them are declared
 * under a name that covers what the consumer reached.
 *
 * A name with a hole in it covers a set of names rather than one, so
 * two providers can both cover what one access reached. Pairing with
 * both reports findings against a boundary the code never touches, and
 * a confident error about the wrong store is worse than no answer, so
 * the more specific name wins and an even contest pairs with nothing.
 *
 * The README beside this file says what specific means here.
 */

import { fixedTextLength, namePatternKey } from "@suss/ir-core";

/** One provider, with the name of its own that covered what was reached. */
export interface NameCandidate<T> {
  subject: T;
  name: string;
}

export interface NameChoice<T> {
  /** Who to pair with. Empty when an even contest stopped the pairing. */
  chosen: T[];
  /** The candidates that tied, for a caller that wants to say so. */
  tied: NameCandidate<T>[];
}

/**
 * The candidates whose name states the most fixed text. Two spellings
 * of one name (`{env}-orders` and `{stage}-orders`) are the same name
 * and both are chosen, since the two sides of a deployment spell the
 * same parameter their own way.
 */
export function mostSpecificName<T>(
  candidates: NameCandidate<T>[],
): NameChoice<T> {
  if (candidates.length === 0) {
    return { chosen: [], tied: [] };
  }
  const stated = candidates.map((candidate) => fixedTextLength(candidate.name));
  const most = Math.max(...stated);
  const winners = candidates.filter(
    (_candidate, index) => stated[index] === most,
  );
  const spellings = new Set(
    winners.map((winner) => namePatternKey(winner.name)),
  );
  if (spellings.size > 1) {
    return { chosen: [], tied: winners };
  }
  return { chosen: winners.map((winner) => winner.subject), tied: [] };
}
