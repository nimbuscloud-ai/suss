/**
 * Groups a diff line that one wrapper produced at many boundaries into a
 * single statement.
 *
 * A filter, a middleware or an error handler runs around every route
 * registered with it, so editing one of them changes every route it
 * covers. Printed route by route, the same line would appear fifty times
 * and the reader would have to work out that one edit caused all of them.
 * The report prints it once instead, with how many routes have it and
 * which covered routes do not.
 */

import type { WrapperReference } from "@suss/behavioral-ir";

/** One line of a boundary's block, and the wrapper that produced it. */
export interface CausedLine {
  /** The block this line belongs to, as `file::unit`. */
  readonly key: string;
  /** The boundary's label in the report, which the exception list uses. */
  readonly boundary: string;
  readonly change: "added" | "removed";
  readonly outcome: string;
  readonly wrapper: WrapperReference | undefined;
}

/** The same line at several boundaries, and where it came from. */
export interface SharedCause {
  readonly wrapper: WrapperReference;
  readonly change: "added" | "removed";
  readonly outcome: string;
  /** The blocks this line came from, so the report can drop it from each one. */
  readonly keys: ReadonlySet<string>;
  /** The labels of the boundaries that got this line. */
  readonly boundaries: readonly string[];
  /** The boundaries the wrapper runs on that did not get this line. */
  readonly exceptions: readonly string[];
  /** How many boundaries the wrapper runs on at all. */
  readonly covered: number;
}

/** Above this many boundaries, the statement prints a count instead of the labels. */
const NAMED = 3;

/** Under one wrapper, what it stopped producing lists before what it started. */
const CHANGE_ORDER: Record<CausedLine["change"], number> = {
  removed: 0,
  added: 1,
};

function wrapperKey(wrapper: WrapperReference): string {
  return `${wrapper.file}::${wrapper.name}`;
}

/**
 * Whether a boundary the change missed already ends up like the others:
 * it produced an added outcome before the change, or it never produced a
 * removed one. Nothing about that boundary changed, so listing it as an
 * exception would send a reviewer looking for a problem that is not there.
 */
function alreadySo(
  line: CausedLine,
  boundary: string,
  produces: (boundary: string, outcome: string) => boolean,
): boolean {
  return line.change === "added"
    ? produces(boundary, line.outcome)
    : !produces(boundary, line.outcome);
}

/**
 * Every line that the same wrapper produced at more than one boundary.
 * `runsOn` returns the boundaries a wrapper covers, and the count and the
 * exceptions are measured against that list.
 */
export function sharedCauses(
  lines: readonly CausedLine[],
  runsOn: (wrapper: WrapperReference) => readonly string[],
  produces: (boundary: string, outcome: string) => boolean,
): SharedCause[] {
  const groups = new Map<string, CausedLine[]>();
  for (const line of lines) {
    if (line.wrapper === undefined) {
      continue;
    }
    const key = `${wrapperKey(line.wrapper)} ${line.change} ${line.outcome}`;
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
      change: first.change,
      outcome: first.outcome,
      keys: new Set(group.map((line) => line.key)),
      boundaries: got,
      exceptions: covered.filter(
        (boundary) =>
          !got.includes(boundary) && !alreadySo(first, boundary, produces),
      ),
      covered: Math.max(covered.length, got.length),
    });
  }

  return causes.sort(
    (a, b) =>
      wrapperKey(a.wrapper).localeCompare(wrapperKey(b.wrapper)) ||
      CHANGE_ORDER[a.change] - CHANGE_ORDER[b.change] ||
      a.outcome.localeCompare(b.outcome),
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
 * The boundaries that have this line now, and the ones the same wrapper
 * runs on without it. The second line lets a reviewer check a route they
 * expected the change to cover.
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
