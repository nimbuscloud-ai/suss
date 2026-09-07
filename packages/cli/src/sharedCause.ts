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
  /** The boundaries that got this line, by the label the report gives them. */
  readonly boundaries: readonly string[];
  /** The boundaries the wrapper runs on that did not get this line. */
  readonly exceptions: readonly string[];
  /** How many boundaries the wrapper runs on at all. */
  readonly covered: number;
}

/** Past this many boundaries, a statement gives the count instead. */
const NAMED = 3;

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
    const got = [...new Set(group.map((line) => line.boundary))].sort();
    const covered = runsOn(first.wrapper);
    causes.push({
      wrapper: first.wrapper,
      text: first.text,
      keys: new Set(group.map((line) => line.key)),
      boundaries: got,
      exceptions: covered.filter((boundary) => !got.includes(boundary)),
      covered: Math.max(covered.length, got.length),
    });
  }

  return causes.sort(
    (a, b) =>
      wrapperKey(a.wrapper).localeCompare(wrapperKey(b.wrapper)) ||
      a.text.localeCompare(b.text),
  );
}

/** `GET /a, GET /b and GET /c`, for a list short enough to read. */
function inWords(items: readonly string[]): string {
  if (items.length <= 2) {
    return items.join(" and ");
  }
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * Which boundaries have this now, and which ones the same wrapper runs
 * on without it. A reviewer reads the second line to check a route they
 * thought was covered.
 */
export function scopeLines(cause: SharedCause): string[] {
  const at =
    cause.boundaries.length <= NAMED
      ? `at ${inWords(cause.boundaries)}`
      : `at ${cause.boundaries.length} of the ${cause.covered} boundaries it runs on`;

  if (cause.exceptions.length === 0) {
    return [at];
  }
  if (cause.exceptions.length <= NAMED) {
    return [at, `not at ${inWords(cause.exceptions)}, which it also runs on`];
  }
  return [at, `not at ${cause.exceptions.length} others it runs on`];
}
