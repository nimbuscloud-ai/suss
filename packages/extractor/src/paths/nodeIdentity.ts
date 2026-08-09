// nodeIdentity.ts: collections keyed by a node's id rather than by the object.
// A parser that hands back a fresh wrapper on every read, which tree-sitter
// does, makes a plain Set or Map match nothing. See the adapters' READMEs.

/** Anything with a stable id, which is what these key on. */
export interface Identified {
  readonly id: number;
}

/** A set of nodes, compared by id. */
export class IdSet<T extends Identified> implements Iterable<T> {
  private readonly byKey = new Map<number, T>();

  constructor(nodes: Iterable<T> = []) {
    for (const node of nodes) {
      this.add(node);
    }
  }

  add(node: T): this {
    this.byKey.set(node.id, node);
    return this;
  }

  has(node: T): boolean {
    return this.byKey.has(node.id);
  }

  /** The node this set was built with, which is the caller's own handle for it. */
  get(node: T): T | undefined {
    return this.byKey.get(node.id);
  }

  get size(): number {
    return this.byKey.size;
  }

  [Symbol.iterator](): Iterator<T> {
    return this.byKey.values();
  }
}

/** A map keyed by node, compared by id. */
export class IdMap<T extends Identified, V> implements Iterable<[T, V]> {
  private readonly entries = new Map<number, [T, V]>();

  set(node: T, value: V): this {
    this.entries.set(node.id, [node, value]);
    return this;
  }

  get(node: T): V | undefined {
    return this.entries.get(node.id)?.[1];
  }

  has(node: T): boolean {
    return this.entries.has(node.id);
  }

  get size(): number {
    return this.entries.size;
  }

  [Symbol.iterator](): Iterator<[T, V]> {
    return this.entries.values();
  }
}
