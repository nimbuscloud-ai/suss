/**
 * One statement for a change that reached many boundaries from one
 * place.
 *
 * A filter, a middleware or an error handler runs around every route
 * registered with it, so editing one of them moves every route it
 * covers. Printed route by route, that is the same line fifty times and
 * a reader has to work out for themselves that it came from one edit.
 * Printed once, with how many routes have it and which ones do not, it
 * is the sentence they were going to write in the review anyway.
 */

import type { WrapperReference } from "@suss/behavioral-ir";

/** One line of a boundary's block, and the wrapper that produced it. */
export interface CausedLine {
  /** The block this line belongs to, as `file::unit`. */
  readonly key: string;
  /** How the report names the boundary, for the exceptions. */
  readonly boundary: string;
  readonly text: string;
  readonly wrapper: WrapperReference | undefined;
}

/** The same line at several boundaries, and where it came from. */
export interface SharedCause {
  readonly wrapper: WrapperReference;
  readonly text: string;
  /** The blocks this line came out of, so they can drop it. */
  readonly keys: ReadonlySet<string>;
  /** The boundaries the wrapper runs on that did not get this line. */
  readonly exceptions: readonly string[];
  /** How many boundaries the wrapper runs on at all. */
  readonly covered: number;
}

/** Past this many exceptions, a statement gives the count instead. */
const EXCEPTIONS_NAMED = 3;

function wrapperKey(wrapper: WrapperReference): string {
  return `${wrapper.file}::${wrapper.name}`;
}

/**
 * Every line that turned up at more than one boundary from the same
 * wrapper. `runsOn` gives the boundaries a wrapper covers, which is
 * what the count and the exceptions are measured against.
 */
export function sharedCauses(
  lines: readonly CausedLine[],
  runsOn: (wrapper: WrapperReference) => readonly string[],
): SharedCause[] {
  const groups = new Map<string, CausedLine[]>();
  for (const line of lines) {
    if (line.wrapper === undefined) {
      continue;
    }
    const key = `${wrapperKey(line.wrapper)} ${line.text}`;
    groups.set(key, [...(groups.get(key) ?? []), line]);
  }

  const causes: SharedCause[] = [];
  for (const group of groups.values()) {
    const first = group[0];
    if (first?.wrapper === undefined || group.length < 2) {
      continue;
    }
    const got = new Set(group.map((line) => line.boundary));
    const covered = runsOn(first.wrapper);
    causes.push({
      wrapper: first.wrapper,
      text: first.text,
      keys: new Set(group.map((line) => line.key)),
      exceptions: covered.filter((boundary) => !got.has(boundary)),
      covered: Math.max(covered.length, group.length),
    });
  }

  return causes.sort(
    (a, b) =>
      wrapperKey(a.wrapper).localeCompare(wrapperKey(b.wrapper)) ||
      a.text.localeCompare(b.text),
  );
}

/** How wide the change reaches, and which boundaries it misses. */
export function scopeLine(cause: SharedCause): string {
  const at = `at ${cause.keys.size} of the ${cause.covered} boundaries it runs on`;
  if (cause.exceptions.length === 0) {
    return `${at}, all of them`;
  }
  if (cause.exceptions.length <= EXCEPTIONS_NAMED) {
    const named = cause.exceptions.join(", ");
    return `${at}; ${named} ${cause.exceptions.length === 1 ? "is the exception" : "are the exceptions"}`;
  }
  return `${at}; ${cause.exceptions.length} of them do not have it`;
}
