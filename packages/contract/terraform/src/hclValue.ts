/**
 * Helpers for the values the HCL parser returns.
 *
 * A block written once and a block written several times come back
 * differently, and a value may be a string, a list, or a record of
 * either, so a reader that expects one form has to normalize it. Three
 * readers also walk a whole value to reach the strings inside it: to
 * resolve the references in a module argument, to fill an iterator
 * into a block, and to check whether an iterator is still there.
 * `mapStrings` and `someString` are that walk, written once.
 */

/** The parser returns one block as a record and several as a list. */
export function arrayOf(value: unknown): unknown[] {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function stringOf(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function recordsIn(value: unknown): Array<Record<string, unknown>> {
  return arrayOf(value)
    .map(asRecord)
    .filter((record): record is Record<string, unknown> => record !== null);
}

/**
 * Rewrites every string in a value, however deeply nested. Anything
 * other than a string, a list or a record comes back unchanged, since
 * only text can contain a reference.
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
