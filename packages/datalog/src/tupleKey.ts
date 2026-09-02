// tupleKey.ts: turning several values into one string key, reversibly.
//
// A tuple value can be any string a caller interns, so no separator
// character is safe to join on. Pick one, and the day a module
// specifier or an identifier contains it, two different tuples produce
// the same key and a lookup returns the wrong facts. Each part is
// written with its own length instead, which no value can forge.
//
// The database keys its tuples this way, and anything outside it that
// joins values into a map key has the same problem, so the encoding
// lives here for both to share.

import type { Atom } from "./index.js";

const atomKey = (a: Atom): string =>
  typeof a === "number" ? `n${a}:` : `s${a.length}:${a}`;

// Every fact added, looked up, or removed comes through here, so the
// loop is written out rather than mapped and joined: one string is
// built instead of an array of them and then a string.
export const tupleKey = (parts: readonly Atom[]): string => {
  let key = "";
  for (let i = 0; i < parts.length; i++) {
    key += atomKey(parts[i]);
  }
  return key;
};

/**
 * Throws on a string `tupleKey` did not produce. A key that does not
 * parse means a caller mixed two encodings, and parsing it leniently
 * would make every result after it quietly wrong.
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
