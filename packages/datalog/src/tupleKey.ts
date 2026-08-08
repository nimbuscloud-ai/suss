// tupleKey.ts: turning several values into one string key, reversibly.
//
// A tuple value can be any string a caller interns, so no separator
// character is safe to join on: pick one and the day a module
// specifier or an identifier contains it, two different tuples answer
// to the same key and a lookup returns the wrong facts. Each part
// carries its own length instead, which no value can forge.
//
// The database keys its tuples this way, and anything outside that
// joins values into a map key has the same problem, so the encoding
// lives here for both to share.

import type { Atom } from "./index.js";

/** One value, prefixed by what it is and how long it is. */
const atomKey = (a: Atom): string =>
  typeof a === "number" ? `n${a}:` : `s${a.length}:${a}`;

/** Several values as one key. Equal keys mean equal tuples. */
export const tupleKey = (parts: readonly Atom[]): string =>
  parts.map(atomKey).join("");

/**
 * The values a key was built from, as strings; a number comes back as
 * the text it was written as. Throws on a string this function did not
 * write, because a key that does not parse means a caller joined two
 * encodings and every answer after it would be silently wrong.
 */
export function tupleKeyParts(key: string): string[] {
  const parts: string[] = [];
  let at = 0;
  while (at < key.length) {
    const colon = key.indexOf(":", at);
    if (colon === -1) {
      throw new Error(`not a tuple key: ${key}`);
    }
    const kind = key[at];
    const header = key.slice(at + 1, colon);
    if (kind === "n") {
      parts.push(header);
      at = colon + 1;
      continue;
    }

    const length = Number(header);
    if (kind !== "s" || !Number.isInteger(length) || length < 0) {
      throw new Error(`not a tuple key: ${key}`);
    }
    const end = colon + 1 + length;
    if (end > key.length) {
      throw new Error(`not a tuple key: ${key}`);
    }
    parts.push(key.slice(colon + 1, end));
    at = end;
  }
  return parts;
}
