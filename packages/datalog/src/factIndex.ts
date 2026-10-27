/**
 * Which tuples a relation has, and what identifies one of them to
 * everything else. The tag stored for a fact, each rule set's ledger of
 * what it derived, and a caller's claim on a fact it asserted all point
 * at a fact through the key this hands out.
 *
 * The join asks for that key again on every candidate the rules
 * consider, so what the key costs to work out sets the cost of
 * evaluation. A relation finds a fact by walking a trie of its tuple's
 * atoms, one map hop per column, to the first column where no other
 * tuple shares the atoms so far. The key is stored there, and the walk
 * compares the rest of the tuple instead of taking a map per column.
 * DESIGN.md says why the walk is over the atoms, not interned integers.
 */

import type { Atom, Tuple } from "./index.js";

/**
 * What identifies one fact inside one relation. Opaque: a key means
 * nothing to the relation that did not hand it out, and nothing outside
 * this module reads its fields.
 */
export class FactKey {
  present = false;
  tag: unknown = undefined;

  constructor(readonly tuple: Tuple) {}
}

/** Where tuples that agree up to some column part ways. */
class Branch {
  /** The key of a tuple that ends at this column, as a shorter one in a relation of mixed arity does. */
  here: FactKey | undefined = undefined;
  readonly next = new Map<Atom, FactKey | Branch>();
}

/** Whether two tuples that agree before `from` agree on the rest. */
function sameFrom(a: Tuple, b: Tuple, from: number): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let at = from; at < a.length; at++) {
    if (a[at] !== b[at]) {
      return false;
    }
  }
  return true;
}

/** File a key under a branch for the column `depth`. */
function place(branch: Branch, key: FactKey, depth: number): void {
  if (depth === key.tuple.length) {
    branch.here = key;
  } else {
    branch.next.set(key.tuple[depth] as Atom, key);
  }
}

/** The one key a branch has left and nothing else, which can take the branch's place. */
function soleKey(branch: Branch): FactKey | undefined {
  if (branch.here !== undefined) {
    return branch.next.size === 0 ? branch.here : undefined;
  }
  if (branch.next.size !== 1) {
    return undefined;
  }
  const only = branch.next.values().next().value;
  return only instanceof FactKey ? only : undefined;
}

/** The facts one relation has, and the tag stored against each. */
export class FactIndex {
  /** How many facts are present. */
  size = 0;

  private root = new Branch();

  /** This tuple's key here, whether or not the fact is present. */
  key(tuple: Tuple): FactKey {
    let branch = this.root;
    for (let depth = 0; ; depth++) {
      if (depth === tuple.length) {
        branch.here ??= new FactKey(tuple);
        return branch.here;
      }
      const atom = tuple[depth] as Atom;
      const child = branch.next.get(atom);
      if (child === undefined) {
        const key = new FactKey(tuple);
        branch.next.set(atom, key);
        return key;
      }
      if (child instanceof Branch) {
        branch = child;
        continue;
      }
      if (sameFrom(child.tuple, tuple, depth + 1)) {
        return child;
      }
      // Another tuple shares this column's atom, so the column after it
      // has to tell them apart.
      const split = new Branch();
      place(split, child, depth + 1);
      branch.next.set(atom, split);
      branch = split;
    }
  }

  /** The key of a fact this relation has, or undefined when it has none. */
  find(tuple: Tuple): FactKey | undefined {
    let branch = this.root;
    for (let depth = 0; ; depth++) {
      const child =
        depth === tuple.length
          ? branch.here
          : branch.next.get(tuple[depth] as Atom);
      if (child === undefined) {
        return undefined;
      }
      if (child instanceof Branch) {
        branch = child;
        continue;
      }
      return child.present && sameFrom(child.tuple, tuple, depth + 1)
        ? child
        : undefined;
    }
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
   * Drop a removed tuple's key, and any branch left with one key to
   * tell apart. Without this a relation that is retracted from over and
   * over keeps a key per tuple it ever had.
   */
  prune(tuple: Tuple): void {
    const path: Branch[] = [];
    let branch = this.root;
    let depth = 0;
    for (; ; depth++) {
      path.push(branch);
      const child =
        depth === tuple.length
          ? branch.here
          : branch.next.get(tuple[depth] as Atom);
      if (child === undefined) {
        return;
      }
      if (child instanceof Branch) {
        branch = child;
        continue;
      }
      if (child.present || !sameFrom(child.tuple, tuple, depth + 1)) {
        return;
      }
      break;
    }
    if (depth === tuple.length) {
      branch.here = undefined;
    } else {
      branch.next.delete(tuple[depth] as Atom);
    }
    // A branch has two keys or more under it. One left with a single key
    // gives its place in the branch above to that key, and the branch
    // above may then do the same.
    for (let at = path.length - 1; at > 0; at--) {
      const sole = soleKey(path[at] as Branch);
      if (sole === undefined) {
        return;
      }
      (path[at - 1] as Branch).next.set(tuple[at - 1] as Atom, sole);
    }
  }

  /** Drop every fact, and whatever was kept in order to find them. */
  clear(): void {
    this.root = new Branch();
    this.size = 0;
  }
}
