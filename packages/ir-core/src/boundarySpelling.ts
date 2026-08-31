/**
 * How somebody spells a boundary they want to talk about, and whether
 * what they wrote picks out a given one.
 *
 * The words get cut into tokens, the boundary does too, and a boundary
 * matches when it has every token somebody wrote. So
 * `aws.dynamodb:editions` matches the table and every index on it, and
 * adding `#by-publication` narrows it to the one index.
 *
 * `suss ask`, `suss check --at` and an intent document that says which
 * store a write reaches all read this, so the question and the
 * assertion are spelled and resolved the same way.
 */

import { displayLabel } from "./boundaryKey.js";

import type { BoundaryBinding } from "./index.js";

/**
 * The words in a boundary spelling. Separators between parts of a name
 * are cut, and the characters inside one part are left alone, so
 * `by-publication` stays one word and `{id}` and `:id` both come out as
 * `id`.
 */
export function spellingTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[{}]/g, " ")
    .split(/[\s:#,()/]+/)
    .filter((token) => token.length > 0);
}

/** Every word this boundary can be asked about by. */
export function bindingTokens(binding: BoundaryBinding): Set<string> {
  const tokens = new Set(spellingTokens(displayLabel(binding)));
  for (const value of Object.values(binding.semantics)) {
    if (typeof value === "string") {
      for (const token of spellingTokens(value)) {
        tokens.add(token);
      }
    }
  }
  // A word OpenTelemetry spells with a dot in it, "aws.dynamodb", is
  // askable by its parts too, so somebody types the product name.
  for (const token of [...tokens]) {
    for (const part of token.split(".")) {
      tokens.add(part);
    }
  }
  return tokens;
}

/**
 * Whether what somebody typed is the whole of this boundary's name
 * rather than part of it. `POST /articles` is exactly the collection
 * route and only part of `POST /articles/{slug}/comments`.
 */
export function namesBoundaryExactly(
  subject: string,
  binding: BoundaryBinding,
): boolean {
  const wanted = new Set(spellingTokens(subject));
  if (wanted.size === 0) {
    return false;
  }
  const spelled = new Set(spellingTokens(displayLabel(binding)));
  if (spelled.size !== wanted.size) {
    return false;
  }
  return [...spelled].every((token) => wanted.has(token));
}

/** Whether what somebody typed picks out this boundary. */
export function namesBoundary(
  subject: string,
  binding: BoundaryBinding,
): boolean {
  const wanted = spellingTokens(subject);
  if (wanted.length === 0) {
    return false;
  }
  const tokens = bindingTokens(binding);
  return wanted.every((token) => tokens.has(token));
}
