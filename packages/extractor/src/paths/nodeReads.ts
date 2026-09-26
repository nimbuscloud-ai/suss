/**
 * The enclosing definition of a tree-sitter node, kept for as long as
 * its parse is.
 *
 * A fact key includes the function a node is written in, so an adapter
 * looks it up for every read it keys, and each step up the tree is a call
 * into tree-sitter's wasm module that builds a fresh wrapper. A parse tree
 * does not change once it is built, so each result is kept in a WeakMap
 * keyed on the tree. The results go when the tree does, and a parse made
 * in a later run starts with nothing kept.
 *
 * Only this read is kept. Keeping each node's children and fields too
 * cost more memory than it saved time.
 */

/** What the reader needs from a parse tree node. */
export interface ParsedNode<T> {
  readonly id: number;
  readonly type: string;
  readonly tree: object;
  readonly parent: T | null;
}

/** The nearest ancestor of each node whose type is one of `types`, read once per parse. */
export class EnclosingNodes<T extends ParsedNode<T>> {
  private readonly byTree = new WeakMap<object, Map<number, T | null>>();

  constructor(private readonly types: ReadonlySet<string>) {}

  /**
   * The nearest ancestor of one of the types, or null when there is none.
   * Every node passed on the way up has the same result, so each one is
   * kept, and a later read from a sibling stops one step up.
   */
  of(node: T): T | null {
    const kept = this.keptFor(node.tree);
    const known = kept.get(node.id);
    if (known !== undefined) {
      return known;
    }
    const passed: number[] = [node.id];
    let current = node.parent;
    while (current !== null && !this.types.has(current.type)) {
      const above = kept.get(current.id);
      if (above !== undefined) {
        current = above;
        break;
      }
      passed.push(current.id);
      current = current.parent;
    }
    for (const id of passed) {
      kept.set(id, current);
    }
    return current;
  }

  private keptFor(tree: object): Map<number, T | null> {
    const known = this.byTree.get(tree);
    if (known !== undefined) {
      return known;
    }
    const fresh = new Map<number, T | null>();
    this.byTree.set(tree, fresh);
    return fresh;
  }
}
