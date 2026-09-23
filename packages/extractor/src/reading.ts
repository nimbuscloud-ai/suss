/**
 * `Reading<T>`: what a reader found, in the four states a source can leave a
 * value in.
 *
 * A reader that returns `T | null` makes null mean three things at once: the
 * source left the value out, the source wrote it and the reader could not
 * evaluate it, or several candidates matched and the reader picked none.
 * Each needs a different note on the summary, and `T | null` does not show
 * which case happened, so every new reader has to choose again and some
 * choose wrong.
 *
 * The rule that turns a reading into a claim, a library default, or a gap
 * is in the summary builder in this package and is not exported.
 */

/** Where in a file a value is written, as byte offsets into that file. */
export interface SourceRange {
  start: number;
  end: number;
}

/**
 * What a reader found where a value could be. `written` is the only state
 * with a value a summary may claim, and the other three each say something
 * different about why there is no claim to make.
 */
export type Reading<T> =
  | { kind: "written"; value: T; range: SourceRange }
  | { kind: "absent" }
  | { kind: "unreadable"; reason: string; range: SourceRange }
  | {
      kind: "ambiguous";
      candidates: readonly T[];
      reason: string;
      range: SourceRange;
    };

/** The source gives this value, here, and the reader read it. */
export function writtenReading<T>(value: T, range: SourceRange): Reading<T> {
  return { kind: "written", value, range };
}

/**
 * The source says nothing where this value could be. A library that defines
 * a default for it may still supply one, and the summary builder applies
 * that default only when a pack declares it as data.
 */
export const absentReading: Reading<never> = { kind: "absent" };

/**
 * The source gives the value and the reader could not evaluate it. The
 * reason is the sentence somebody reading the summary will see, so write it
 * about what could not be read rather than about the code.
 */
export function unreadableReading<T>(
  reason: string,
  range: SourceRange,
): Reading<T> {
  return { kind: "unreadable", reason, range };
}

/**
 * Several values could be right and the reader picked none. The candidates
 * are kept through every later step, so code that can choose among them
 * still has them.
 *
 * The range is where somebody should look to see the ambiguity. An ambiguity
 * often spans more than one place (two mounts of one router, in two files),
 * so give the site the reading was taken at, the same one an `unreadable`
 * reading here would have given.
 */
export function ambiguousReading<T>(
  candidates: readonly T[],
  reason: string,
  range: SourceRange,
): Reading<T> {
  return { kind: "ambiguous", candidates, reason, range };
}

/**
 * A reading paired with what the library does when the source says nothing.
 * Only a pack may supply that default, so the value a summary claims for an
 * unstated field always comes from a pack's declaration about the library.
 */
export interface DefaultedReading<T> {
  /** What the source said. */
  reading: Reading<T>;
  /**
   * The value the library applies when the source gives none, as the pack
   * declared it. Leave it out when the library defines no default, and then
   * a source that says nothing gets no claim.
   */
  libraryDefault?: T;
}

type ReadingTable<T, R> = {
  [K in Reading<T>["kind"]]: (reading: Extract<Reading<T>, { kind: K }>) => R;
};

function dispatchReading<T, R>(
  table: ReadingTable<T, R>,
  reading: Reading<T>,
): R {
  return (table[reading.kind] as (r: Reading<T>) => R)(reading);
}

/**
 * The same reading with its value in another form. A written value goes
 * through `f` and keeps its range. An ambiguous reading's candidates go
 * through `f` too, so the alternatives end up in the same form as the
 * chosen value would. Absent and unreadable readings pass through
 * unchanged, since neither one has a value to convert.
 */
export function mapReading<T, U>(
  reading: Reading<T>,
  f: (value: T) => U,
): Reading<U> {
  const table: ReadingTable<T, Reading<U>> = {
    written: (r) => writtenReading(f(r.value), r.range),
    absent: () => absentReading,
    unreadable: (r) => unreadableReading(r.reason, r.range),
    ambiguous: (r) => ambiguousReading(r.candidates.map(f), r.reason, r.range),
  };
  return dispatchReading(table, reading);
}

/**
 * Read further from what this reading found. `f` runs on a written
 * value with the range it was written at, so a step that turns out to
 * be unreadable can say so against the same syntax.
 *
 * `f` runs on each of an ambiguous reading's candidates too, and the ones
 * that do read come back as the candidates of an ambiguous reading with the
 * same reason. The alternatives reach the summary instead of being dropped
 * at the first step that reads further.
 */
export function andThenReading<T, U>(
  reading: Reading<T>,
  f: (value: T, range: SourceRange) => Reading<U>,
): Reading<U> {
  const table: ReadingTable<T, Reading<U>> = {
    written: (r) => f(r.value, r.range),
    absent: () => absentReading,
    unreadable: (r) => unreadableReading(r.reason, r.range),
    ambiguous: (r) =>
      ambiguousReading(
        r.candidates.flatMap((candidate) => {
          const next = f(candidate, r.range);
          return next.kind === "written" ? [next.value] : [];
        }),
        r.reason,
        r.range,
      ),
  };
  return dispatchReading(table, reading);
}

/**
 * Which of several readings a claim comes from, for a value a library lets
 * a source give in more than one place.
 */
export interface ChosenReading<T> {
  /**
   * The reading a claim comes from: the first that was written, or if none
   * was, the first that failed to read, or absent when all of them were
   * absent.
   */
  reading: Reading<T>;
  /**
   * The unreadable or ambiguous readings the choice passed over. A later
   * reading that supplies the value does not settle an earlier one that
   * could not be read, so these still go to the builder and their reasons
   * reach the summary.
   */
  passedOver: readonly Reading<T>[];
}

/**
 * Choose among readings of the same value, taking the first that was
 * written. Nothing is thrown away: whatever the choice passed over and
 * could not read comes back next to it in `passedOver`, so a
 * `response_model` nobody could read still lands as a gap even when the
 * return annotation after it supplies the type.
 */
export function firstWrittenReading<T>(
  readings: readonly Reading<T>[],
): ChosenReading<T> {
  const written = readings.find((reading) => reading.kind === "written");
  const chosen =
    written ??
    readings.find((reading) => reading.kind !== "absent") ??
    absentReading;

  return {
    reading: chosen,
    passedOver: readings.filter(
      (reading) =>
        reading !== chosen &&
        (reading.kind === "unreadable" || reading.kind === "ambiguous"),
    ),
  };
}

/**
 * What a written reading found, for a reader that has to read further from
 * it before anything is claimed. A route's path template gives the
 * parameters that decide what each of the handler's parameters is, and
 * that has to be settled before there is a summary field to fill in.
 *
 * This applies no default and gives no reason, so most summary fields must
 * not be written from it. Pass the reading to the builder instead, which
 * applies the one rule for readings in a place a reviewer can find.
 *
 * The identity fields of a boundary binding are the exception, and the path
 * is one of them. No pack declares a default for what a boundary is called,
 * so the builder would write the same value this returns. Pass the reading
 * to the builder as well, so its reason still becomes a gap.
 */
export function valueToReadFurtherFrom<T>(reading: Reading<T>): T | null {
  return reading.kind === "written" ? reading.value : null;
}
