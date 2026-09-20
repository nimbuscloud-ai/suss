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
