// reading.ts: what a reader answers with, in the four states a source
// can leave a value in.
//
// A reader that answers `T | null` makes null mean three different
// things at once: the source omits the value, the source states it and
// the reader cannot evaluate it, and several candidates match and the
// reader picked none. Each of those asks for a different answer on the
// summary, and which one a caller meant is invisible in the type, so
// every new reader re-decides it and some fraction decides wrong.
//
// `Reading<T>` names all four states. The rule that turns one into a
// claim, a library default, or a gap lives in one place, the summary
// builder in this package, and is not exported, so a reader can compose
// readings but cannot quietly unwrap one into a claim.

/** Where in a file a value is written, as byte offsets into that file. */
export interface SourceRange {
  start: number;
  end: number;
}

/**
 * What a reader found where a value could be. `written` is the only
 * state that carries a value a summary may claim; the other three each
 * say something different about why it does not.
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

/** The source states this value, here, and the reader read it. */
export function writtenReading<T>(value: T, range: SourceRange): Reading<T> {
  return { kind: "written", value, range };
}

/**
 * The source states nothing where this value could be. A library that
 * defines a default for it may still supply one, and the summary
 * builder applies that default only when a pack declares it as data.
 */
export const absentReading: Reading<never> = { kind: "absent" };

/**
 * The source states the value and the reader could not evaluate it. The
 * reason is the sentence a reader of the summary sees, so write it as a
 * sentence about the reading rather than about the code.
 */
export function unreadableReading<T>(
  reason: string,
  range: SourceRange,
): Reading<T> {
  return { kind: "unreadable", reason, range };
}

/**
 * Several values could be the answer and the reader picked none.
 * Carrying the candidates keeps what was found available to whoever
 * later teaches the reader to choose between them, and every step this
 * reading goes through afterwards carries them along.
 *
 * The range is where a reader should look to see the ambiguity. An
 * ambiguity often spans more than one site (two mounts of one router,
 * in two files); name the site the reading was taken at, the same one
 * an `unreadable` reading here would have named.
 */
export function ambiguousReading<T>(
  candidates: readonly T[],
  reason: string,
  range: SourceRange,
): Reading<T> {
  return { kind: "ambiguous", candidates, reason, range };
}

/**
 * A reading paired with what the library does when the source states
 * nothing. Only a pack may supply the default, so the value a summary
 * claims for an unstated field is library-defined and sits in the pack
 * next to the names it already declares.
 */
export interface DefaultedReading<T> {
  /** What the source said. */
  reading: Reading<T>;
  /**
   * The value the library applies when the source states none, as the
   * pack declared it. Left out when the library defines no default, and
   * then a source that states nothing gets no claim.
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
 * through `f` and keeps its range; an ambiguous reading's candidates go
 * through `f` too, so the alternatives stay in the same form as the
 * answer would have been. Absent and unreadable readings pass through
 * unchanged, since neither holds a value to convert.
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
 * `f` runs on each of an ambiguous reading's candidates too, and the
 * ones that read come back as the candidates of an ambiguous reading
 * with the same reason. The alternatives stay alongside the answer all
 * the way to the summary rather than being dropped at the first step
 * that reads further.
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
 * Which of several readings a claim comes from, for a value a library
 * lets a source state in more than one place.
 */
export interface ChosenReading<T> {
  /**
   * The reading a claim comes from: the first that was written, or,
   * when none was, the first that failed to read, or absent when every
   * one of them was.
   */
  reading: Reading<T>;
  /**
   * The readings the choice passed over that nobody could resolve. A
   * later reading supplying the value does not settle what an earlier
   * one said and could not be read, so these are still handed to the
   * builder and their reasons still reach the summary.
   */
  passedOver: readonly Reading<T>[];
}

/**
 * Choose among readings of the same value, taking the first that was
 * written. Nothing is thrown away: whatever the choice passed over and
 * could not read comes back alongside it in `passedOver`, so a
 * `response_model` nobody could read still lands as a gap even when the
 * return annotation after it supplies the shape.
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
 * What a written reading found, for a reader that has to read further
 * from it before anything is claimed: a route's path template names the
 * parameters that decide what each of the handler's parameters is, and
 * that has to be settled before there is a summary field to fill.
 *
 * This applies no default and states no reason, so most of what a
 * summary says must not be written from it. Hand the reading to the
 * builder instead, and the fixed rule applies to it once, where review
 * can see it.
 *
 * The identity fields of a boundary binding are the exception, and the
 * path this reads is one of them. A binding either names where a unit
 * sits or names nothing and pairs with nothing, and no pack declares a
 * default for what a boundary is called, so the value the builder would
 * place is the value this gives back. Hand the reading over as well and
 * the reason still becomes a gap.
 */
export function valueToReadFurtherFrom<T>(reading: Reading<T>): T | null {
  return reading.kind === "written" ? reading.value : null;
}
