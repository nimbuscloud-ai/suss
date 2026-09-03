/**
 * budget.ts: keep a tool's answer inside what a model can read.
 *
 * A CLI report goes to a terminal somebody scrolls. A tool result goes
 * into a context window, and everything it spends there is unavailable
 * to the work the model was doing. A first check over a repository of
 * any size produces hundreds of findings and thousands of unpaired
 * boundaries, so handing all of it back would fill the window and leave
 * the model no room to act on any of it.
 *
 * So an answer shows the first few, counts the rest by kind, and says
 * how to see more. The CLI does the same thing for the same reason,
 * with `--all` as the way through. Here the way through is asking again
 * about one boundary.
 */

/** How many of a list a tool result shows before it starts counting. */
export const SHOWN = 20;

export interface Trimmed<T> {
  shown: T[];
  /** How many were left out. Zero when everything is shown. */
  omitted: number;
  /** How many of each kind there were in total, including the shown. */
  byKind: Record<string, number>;
}

/**
 * The first few of a list, with the rest counted by kind.
 *
 * Counting by kind rather than in total is what makes the trimmed
 * answer worth reading: 300 findings of one kind is one problem, and
 * 300 across twelve kinds is twelve.
 */
export function trim<T>(
  items: readonly T[],
  kindOf: (item: T) => string,
  limit: number = SHOWN,
): Trimmed<T> {
  const byKind: Record<string, number> = {};
  for (const item of items) {
    const kind = kindOf(item);
    byKind[kind] = (byKind[kind] ?? 0) + 1;
  }
  return {
    shown: items.slice(0, limit),
    omitted: Math.max(0, items.length - limit),
    byKind,
  };
}

/** One line saying what was left out and how to see it. */
export function omissionNote(
  omitted: number,
  noun: string,
  howToSeeMore: string,
): string | undefined {
  if (omitted === 0) {
    return undefined;
  }
  return `${omitted} more ${noun} are not shown. ${howToSeeMore}`;
}
