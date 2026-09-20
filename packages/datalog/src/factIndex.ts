/**
 * Which tuples a relation has, and what identifies one of them to
 * everything else. The tag stored for a fact, each rule set's ledger of
 * what it derived, and a caller's claim on a fact it asserted all point
 * at a fact through the key this hands out.
 *
 * The join asks for that key again on every candidate the rules
 * consider, so what the key costs to work out sets the cost of
 * evaluation. A relation finds a fact by walking a trie of its tuple's
 * atoms, one map hop per column, and the node the walk lands on is the
 * fact itself. Nothing is built to identify a tuple, and a membership
 * test that fails stops at the first column that misses. DESIGN.md says
 * why the walk is over the atoms rather than over interned integers.
 */

import type { Atom, Tuple } from "./index.js";

/**
 * What identifies one fact inside one relation. Opaque: a key means
 * nothing to the relation that did not hand it out, and nothing outside
 * this module reads its fields.
 */
export interface FactKey {
  present: boolean;
  tag: unknown;
  next: Map<Atom, FactKey> | undefined;
}

const emptyNode = (): FactKey => ({
  present: false,
  tag: undefined,
  next: undefined,
});

/** The facts one relation has, and the tag stored against each. */
export class FactIndex {
  /** How many facts are present. */
  size = 0;

  private root = emptyNode();

  /** This tuple's key here, whether or not the fact is present. */
  key(tuple: Tuple): FactKey {
    let node = this.root;
    for (let i = 0; i < tuple.length; i++) {
      let next = node.next;
      if (next === undefined) {
        next = new Map();
        node.next = next;
      }
      const atom = tuple[i];
      let child = next.get(atom);
      if (child === undefined) {
        child = emptyNode();
        next.set(atom, child);
      }
      node = child;
    }
    return node;
  }

  /** The key of a fact this relation has, or undefined when it has none. */
  find(tuple: Tuple): FactKey | undefined {
    let node = this.root;
    for (let i = 0; i < tuple.length; i++) {
      const child = node.next?.get(tuple[i]);
      if (child === undefined) {
        return undefined;
      }
      node = child;
    }
    return node.present ? node : undefined;
  }

  has(key: FactKey): boolean {
    return key.present;
  }

  /** Record the fact, under the tag the caller gave it. */
  put(key: FactKey, tag: unknown): void {
    key.present = true;
    key.tag = tag;
    this.size += 1;
  }

  tagOf(key: FactKey): unknown {
    return key.tag;
  }

  setTag(key: FactKey, tag: unknown): void {
    key.tag = tag;
  }

  /** Take the fact away, and the tag with it. */
  remove(key: FactKey): void {
    key.present = false;
    key.tag = undefined;
    this.size -= 1;
  }

  /**
   * Drop what is left of a removed tuple's path, up to the first node
   * another fact still needs. Without this a relation that is retracted
   * from over and over keeps a node per tuple it ever had.
   */
  prune(tuple: Tuple): void {
    const path: FactKey[] = [this.root];
    let node = this.root;
    for (let i = 0; i < tuple.length; i++) {
      const child = node.next?.get(tuple[i]);
      if (child === undefined) {
        return;
      }
      node = child;
      path.push(child);
    }
    for (let i = path.length - 1; i > 0; i--) {
      const child = path[i];
      if (child.present || (child.next?.size ?? 0) > 0) {
        return;
      }
      path[i - 1].next?.delete(tuple[i - 1]);
    }
  }

  /** Drop every fact, and whatever was kept in order to find them. */
  clear(): void {
    this.root = emptyNode();
    this.size = 0;
  }
}
