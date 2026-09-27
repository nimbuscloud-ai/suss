/**
 * One relation's facts: which tuples are there, and an index per column
 * so a join that has a value for a column does not scan them all.
 *
 * A column is indexed the first time something asks for it and stays up
 * to date after that, so a relation nobody joins on that way never gets
 * an index. The join resolves the relation once per literal and then
 * narrows on each of that literal's fixed columns, which is why finding
 * a bucket is a function here rather than a method on the database.
 */

import type { FactIndex } from "./factIndex.js";
import type { Atom, Tuple } from "./index.js";

export interface Relation {
  /** Which tuples are here, and what identifies each of them. */
  index: FactIndex;
  tuples: Tuple[];
  /**
   * Per column position, the tuples under each value at that position.
   * The value is the atom itself: a Map already tells 1 from "1", so
   * encoding it first would build a string out of every node id on every
   * lookup and buy nothing.
   */
  columns: (Map<Atom, Tuple[]> | undefined)[];
  /**
   * Per set of columns, the tuples under each combination of values at
   * those columns, keyed by a bitmask of the column positions. Built and
   * kept up to date the same way as `columns`.
   */
  combined: Map<number, CombinedIndex>;
}

/**
 * A tree of maps with one level per column in `columns`, lowest position
 * first, and the matching tuples at the leaves.
 */
export interface CombinedIndex {
  columns: readonly number[];
  root: Map<Atom, unknown>;
}

/** The column positions a bitmask sets, lowest first. */
function columnsIn(mask: number): number[] {
  const columns: number[] = [];
  for (let column = 0; mask >> column !== 0; column++) {
    if (mask & (1 << column)) {
      columns.push(column);
    }
  }
  return columns;
}

/** File a tuple under its values at the index's columns. */
export function addToCombined(index: CombinedIndex, tuple: Tuple): void {
  const last = index.columns.length - 1;
  if (index.columns[last] >= tuple.length) {
    return;
  }
  let level = index.root;
  for (let at = 0; at < last; at++) {
    const value = tuple[index.columns[at]] as Atom;
    let next = level.get(value) as Map<Atom, unknown> | undefined;
    if (next === undefined) {
      next = new Map();
      level.set(value, next);
    }
    level = next;
  }
  addToBucket(
    level as Map<Atom, Tuple[]>,
    tuple[index.columns[last]] as Atom,
    tuple,
  );
}

/**
 * The facts with `values[i]` at the i-th column `mask` sets, indexing
 * that set of columns if nobody has yet. They come in the order the
 * relation has them, so they are the facts a single column's bucket
 * gives with the ones that disagree on another column left out.
 */
export function combinedBucketIn(
  relation: Relation,
  mask: number,
  values: readonly Atom[],
): readonly Tuple[] {
  let index = relation.combined.get(mask);
  if (index === undefined) {
    index = { columns: columnsIn(mask), root: new Map() };
    for (const tuple of relation.tuples) {
      addToCombined(index, tuple);
    }
    relation.combined.set(mask, index);
  }
  let level: unknown = index.root;
  for (const value of values) {
    level = (level as Map<Atom, unknown>).get(value);
    if (level === undefined) {
      return [];
    }
  }
  return level as Tuple[];
}

export function addToBucket(
  buckets: Map<Atom, Tuple[]>,
  key: Atom,
  tuple: Tuple,
): void {
  const bucket = buckets.get(key);
  if (bucket === undefined) {
    buckets.set(key, [tuple]);
  } else {
    bucket.push(tuple);
  }
}

/** The facts with `value` at `column`, indexing the column if nobody has yet. */
export function bucketIn(
  relation: Relation,
  column: number,
  value: Atom,
): readonly Tuple[] {
  let buckets = relation.columns[column];
  if (buckets === undefined) {
    buckets = new Map();
    for (const tuple of relation.tuples) {
      const at = tuple[column];
      if (at !== undefined) {
        addToBucket(buckets, at, tuple);
      }
    }
    relation.columns[column] = buckets;
  }
  return buckets.get(value) ?? [];
}
