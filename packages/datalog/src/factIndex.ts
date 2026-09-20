/**
 * Which tuples a relation has, and what identifies one of them to
 * everything else. The tag stored for a fact, each rule set's ledger of
 * what it derived, and a caller's claim on a fact it asserted all point
 * at a fact through the key this hands out.
 *
 * The join asks for that key again on every candidate the rules
 * consider, so what the key costs to work out sets the cost of
 * evaluation.
 */

import { tupleKey } from "./tupleKey.js";

import type { Tuple } from "./index.js";

/**
 * What identifies one fact inside one relation. Opaque: a key means
 * nothing to the relation that did not hand it out, and nothing outside
 * this module may read it.
 */
export type FactKey = string;

// One tuple is keyed on the way in, again to retract it, and again for
// every membership test in between, so the key is remembered against
// the tuple itself.
const keys = new WeakMap<Tuple, FactKey>();

const keyOf = (tuple: Tuple): FactKey => {
  const known = keys.get(tuple);
  if (known !== undefined) {
    return known;
  }
  const key = tupleKey(tuple);
  keys.set(tuple, key);
  return key;
};

/** The facts one relation has, and the tag stored against each. */
export class FactIndex {
  /** How many facts are present. */
  size = 0;

  private readonly present = new Set<FactKey>();

  /**
   * Stays undefined until a caller stores a tag, so evaluation without
   * an algebra never allocates it.
   */
  private tags: Map<FactKey, unknown> | undefined;

  /** This tuple's key here, whether or not the fact is present. */
  key(tuple: Tuple): FactKey {
    return keyOf(tuple);
  }

  /** The key of a fact this relation has, or undefined when it has none. */
  find(tuple: Tuple): FactKey | undefined {
    const key = keyOf(tuple);
    return this.present.has(key) ? key : undefined;
  }

  has(key: FactKey): boolean {
    return this.present.has(key);
  }

  /** Record the fact, under the tag the caller gave it. */
  put(key: FactKey, tag: unknown): void {
    this.present.add(key);
    this.size += 1;
    if (tag !== undefined) {
      this.setTag(key, tag);
    }
  }

  tagOf(key: FactKey): unknown {
    return this.tags?.get(key);
  }

  setTag(key: FactKey, tag: unknown): void {
    if (this.tags === undefined) {
      this.tags = new Map();
    }
    this.tags.set(key, tag);
  }

  /** Take the fact away, and the tag with it. */
  remove(key: FactKey): void {
    this.present.delete(key);
    this.tags?.delete(key);
    this.size -= 1;
  }

  /** Drop every fact, and whatever was kept in order to find them. */
  clear(): void {
    this.present.clear();
    this.tags = undefined;
    this.size = 0;
  }
}
