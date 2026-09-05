/**
 * The tree-sitter adapters key a node by its file and byte span,
 * `file:start-end`. This finds the node a key refers to again, for an
 * evaluator that gets a key back from the facts and needs the syntax.
 */

/** What a tree-sitter node offers for finding it by span again. */
export interface SpannedNode<N> {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly parent: N | null;
  descendantForIndex(start: number, end: number): N | null;
}

const SPAN_KEY = /^(.*):(\d+)-(\d+)$/;

/**
 * The node a key refers to: the smallest node over the span, walked up
 * to the one whose span matches. A key that is not a node, such as a
 * name, has none.
 */
export function nodeOfKey<N extends SpannedNode<N>>(
  rootsByFile: ReadonlyMap<string, N>,
  key: string,
): N | null {
  const span = key.match(SPAN_KEY);
  if (span === null) {
    return null;
  }
  const root = rootsByFile.get(span[1] as string);
  const start = Number(span[2]);
  const end = Number(span[3]);
  if (root === undefined || end <= start) {
    return null;
  }
  let current: N | null = root.descendantForIndex(start, end - 1);
  while (current !== null) {
    if (current.startIndex === start && current.endIndex === end) {
      return current;
    }
    if (current.startIndex < start || current.endIndex > end) {
      return null;
    }
    current = current.parent;
  }
  return null;
}
