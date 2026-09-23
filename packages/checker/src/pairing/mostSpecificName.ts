/**
 * Which provider a consumer meant, when several of them are declared
 * under a name that covers what the consumer reached.
 *
 * A name with a hole in it covers a set of names, so two providers can
 * both cover what one access reached. Pairing with both reports
 * findings against a boundary the code never touches. A confident error
 * about the wrong store is worse than no answer, so the more specific
 * name wins, and when two are equally specific the access pairs with
 * neither.
 *
 * The pairing README explains how specificity is measured.
 */

import { fixedTextLength, namePatternKey } from "@suss/ir-core";

/** One provider, with the name of its own that covered what was reached. */
export interface NameCandidate<T> {
  subject: T;
  name: string;
}

export interface NameChoice<T> {
  /** Who to pair with. Empty when two candidates tied. */
  chosen: T[];
  /** The candidates that tied, so the caller can report the tie. */
  tied: NameCandidate<T>[];
}

/**
 * The candidates whose name states the most fixed text. `{env}-orders`
 * and `{stage}-orders` count as one name and both are chosen, because
 * the two sides of a deployment often give the same parameter
 * different names.
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
