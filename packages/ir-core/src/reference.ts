/**
 * A name that says where to go and ask, instead of saying what the
 * name is.
 *
 * A storage layer told which bucket to use writes `{location.bucket}`:
 * the parameter it takes, then the field inside it. A service that
 * reads its table out of the deployment writes `{ORDER_TABLE}`, one
 * variable and no fields. Both are one hole and no fixed text, which
 * is what `namesNothing` is true of, so neither pairs with a declared
 * name until something settles it.
 *
 * Whoever writes one of these and whoever settles it are in different
 * packages, so the spelling lives here and both sides call it.
 */

import { namesNothing } from "./namePattern.js";

/** Where a reference says to go and ask. */
export interface Reference {
  /**
   * The value the code starts from: a parameter of the unit the
   * reference was written in, or a variable the deployment sets.
   */
  root: string;
  /** The fields to read inside it, outermost first. */
  fields: string[];
}

/**
 * How a reference is written. Null when a part of it is empty, since a
 * reference has to say what to ask about.
 */
export function referenceName(reference: Reference): string | null {
  const path = [reference.root, ...reference.fields];
  return path.some((part) => part === "") ? null : `{${path.join(".")}}`;
}

/**
 * The reference a name states, or null when the name states a name
 * rather than where to go and ask.
 */
export function referenceFromName(name: string): Reference | null {
  if (!namesNothing(name)) {
    return null;
  }
  const path = name.slice(1, -1).split(".");
  const root = path[0];
  if (root === undefined || path.some((part) => part === "")) {
    return null;
  }
  return { root, fields: path.slice(1) };
}
