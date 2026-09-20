/**
 * What the parser hands back for one value, and the few things every
 * reader here does to it.
 *
 * A block HCL states once and a block it states many times arrive
 * differently, and a value may be a string, a list, or a record of
 * either, so a reader that wants one shape has to ask. Three readers
 * also walk a whole value to reach the strings inside it: to resolve
 * the references in a module argument, to fill an iterator into a
 * block, and to ask whether an iterator is still in there. That is one
 * walk with three leaves, so it is written once.
 */

/** A value read as a list, since HCL states one block and many alike. */
export function arrayOf(value: unknown): unknown[] {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

/** A value read as a record, or null when it is not one. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A value read as text, or null when the source states none. */
export function stringOf(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Every record a value states, for a caller that wants only those. */
export function recordsIn(value: unknown): Array<Record<string, unknown>> {
  return arrayOf(value)
    .map(asRecord)
    .filter((record): record is Record<string, unknown> => record !== null);
}

/**
 * The same value with every string in it rewritten, however deeply
 * nested. Anything that is not a string, a list or a record comes back
 * as it was, since only text can contain a reference.
 */
export function mapStrings(
  value: unknown,
  leaf: (text: string) => string,
): unknown {
  if (typeof value === "string") {
    return leaf(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => mapStrings(entry, leaf));
  }
  const record = asRecord(value);
  if (record === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(record).map(([name, entry]) => [
      name,
      mapStrings(entry, leaf),
    ]),
  );
}

/** Whether any string anywhere in a value passes the test. */
export function someString(
  value: unknown,
  test: (text: string) => boolean,
): boolean {
  if (typeof value === "string") {
    return test(value);
  }
  if (Array.isArray(value)) {
    return value.some((entry) => someString(entry, test));
  }
  return Object.values(asRecord(value) ?? {}).some((entry) =>
    someString(entry, test),
  );
}
