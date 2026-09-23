/**
 * Keeps a tool result small enough for a model to read.
 *
 * A CLI report goes to a terminal somebody scrolls. A tool result goes
 * into a context window, and every token it uses there is taken from the
 * work the model was doing. A first check over a repository of any size
 * produces hundreds of findings and thousands of unpaired boundaries,
 * and returning all of it would fill the window.
 *
 * So a result shows the first few, counts the rest by kind, and says how
 * to see more. The CLI trims its report the same way and offers `--all`.
 * Here the way to see more is to ask again about one boundary.
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
 * The rest are counted per kind because 300 findings of one kind is one
 * problem, and 300 across twelve kinds is twelve.
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
