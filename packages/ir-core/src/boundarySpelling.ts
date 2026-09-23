/**
 * How a person writes a boundary they want to ask about, and whether
 * what they wrote picks out a given boundary.
 *
 * The text and the boundary are both split into tokens, and a boundary
 * matches when it has every token in the text. So
 * `aws.dynamodb:editions` matches the table and every index on it, and
 * adding `#by-publication` narrows it to the one index.
 *
 * `suss ask`, `suss check --at` and an intent document that gives the
 * store a write reaches all match through these functions, so a
 * question and an assertion resolve the same way.
 */

import { displayLabel } from "./boundaryKey.js";

import type { BoundaryBinding } from "./index.js";

/**
 * The name inside a fully qualified cloud resource id. Any other string
 * comes back unchanged.
 *
 * `arn:aws:lambda:us-east-1:1234:function:prod-worker` and
 * `projects/p/locations/l/functions/prod-worker` are `prod-worker` plus
 * an account and a region. Two deployments of one resource have
 * different full ids, so readers reduce an id to its name here and the
 * two sides compare the part they both know. A Lambda ARN's trailing
 * alias or version is dropped too, since the function is the boundary
 * whichever published version a call reaches.
 */
export function resourceNameIn(spelling: string): string {
  if (spelling.startsWith("arn:")) {
    const segments = spelling.split(":");
    // arn:partition:service:region:account:type:name[:qualifier]
    return segments[6] ?? segments[5] ?? spelling;
  }
  // A GCP resource id is an even number of key/value segments, and the
  // last segment is the resource name. Any other path stays as written.
  const segments = spelling.split("/");
  if (segments.length >= 4 && segments.length % 2 === 0) {
    return segments[segments.length - 1] ?? spelling;
  }
  return spelling;
}

/**
 * The lowercase words in a boundary spelling. The text is split at the
 * separators between parts of a name, and each part is kept whole, so
 * `by-publication` stays one word and `{id}` and `:id` both become `id`.
 */
export function spellingTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[{}]/g, " ")
    .split(/[\s:#,()/]+/)
    .filter((token) => token.length > 0);
}

/** Every word a person can use to ask about this boundary. */
export function bindingTokens(binding: BoundaryBinding): Set<string> {
  const tokens = new Set(spellingTokens(displayLabel(binding)));
  for (const value of Object.values(binding.semantics)) {
    if (typeof value === "string") {
      for (const token of spellingTokens(value)) {
        tokens.add(token);
      }
    }
  }
  // OpenTelemetry writes some systems with a dot, like "aws.dynamodb",
  // and a person asking usually types only the product name.
  for (const token of [...tokens]) {
    for (const part of token.split(".")) {
      tokens.add(part);
    }
  }
  return tokens;
}

/**
 * Whether the typed text has every word of this boundary's label and
 * nothing more. `POST /articles` matches the collection route exactly,
 * and only partly matches `POST /articles/{slug}/comments`.
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

/** Whether the typed text picks out this boundary: every word in it is one of the boundary's words. */
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
