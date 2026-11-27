/**
 * Whether something a framework pack read beside its routes, such as a
 * rewrite, a proxy or a static file, can serve one call.
 *
 * A pack writes what each one serves as a route path when it can, and
 * as a regular expression over the request path when the framework's
 * own syntax goes further than a route path does, as a Next.js matcher
 * with a negative lookahead does. A call's path can have holes in it,
 * and a regular expression is tried with each hole filled in by every
 * word the expression spells, so a hole that could be that word is not
 * missed.
 */

import { methodsAgree, routePathsMeet } from "@suss/ir-core";

import type { ServedBesideEntry } from "@suss/behavioral-ir";

/** Past this many fillings the call is taken to be served, rather than guessed at. */
const FILLINGS_CAP = 256;

/** What fills a hole that matches none of the words the expression spells. */
const ANY_WORD = "suss-any";

const HOLE = /^\{[^{}]*\}$/;

/** Whether the entry can serve a call with this method to this path. */
export function servesCall(
  entry: ServedBesideEntry,
  method: string,
  path: string,
): boolean {
  if (
    entry.methods !== undefined &&
    !entry.methods.some((served) => methodsAgree(served, method))
  ) {
    return false;
  }
  if (entry.path !== undefined) {
    return routePathsMeet(entry.path, path);
  }
  if (entry.pattern !== undefined) {
    return patternMatchesCall(entry.pattern, path);
  }
  return true;
}

function patternMatchesCall(pattern: string, path: string): boolean {
  let expression: RegExp;
  try {
    expression = new RegExp(pattern);
  } catch {
    return true;
  }
  const fillings = callFillings(path, wordsIn(pattern));
  if (fillings === null) {
    return true;
  }
  return fillings.some((filled) => expression.test(filled));
}

/** The words a regular expression spells out, which a hole in a call could be. */
function wordsIn(pattern: string): string[] {
  const words = pattern.match(/[A-Za-z0-9_~-]+/g) ?? [];
  return [...new Set(words)].filter((word) => word.length > 1);
}

/** The call's path with every hole filled in each way, or null past the cap. */
function callFillings(path: string, words: readonly string[]): string[] | null {
  let filled = [""];
  for (const segment of path.split("/").slice(1)) {
    const options = HOLE.test(segment) ? [ANY_WORD, ...words] : [segment];
    if (filled.length * options.length > FILLINGS_CAP) {
      return null;
    }
    filled = filled.flatMap((head) =>
      options.map((option) => `${head}/${option}`),
    );
  }
  return filled.map((one) => (one === "" ? "/" : one));
}
