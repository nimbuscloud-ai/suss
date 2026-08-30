/**
 * nodeWalk.ts: the one recursion the adapters use to read a declaration
 * wherever the language allows it to be written.
 *
 * A declaration goes where a statement goes, and every language has more
 * places for a statement than a reader remembers to list. So an adapter
 * does not list the containers it descends into. It walks every named
 * child and says only which nodes keep their own body, because that set
 * is short and a grammar's own vocabulary already names it.
 */

/** A parse tree, however a grammar spells one. */
export interface WalkableNode<T> {
  readonly namedChildren: ReadonlyArray<T | null>;
}

/**
 * Returned by `into` for a node whose children the walk should leave
 * unread, such as one whose body belongs to what it declares. A symbol,
 * so it cannot collide with whatever a caller carries.
 */
export const SKIP_CHILDREN: unique symbol = Symbol("skipChildren");

/** What a walk does at each node it reaches. */
export interface NodeVisitor<T, C> {
  /** Called once per node, in source order, before its own children. */
  at(node: T, carried: C): void;
  /** What to carry into this node's children, or `SKIP_CHILDREN` to leave them unread. */
  into(node: T, carried: C): C | typeof SKIP_CHILDREN;
}

/**
 * Every named node under `root`, depth first and in source order, with a
 * value the visitor updates as the walk descends. `root` itself is not
 * visited, because a caller starts from the body it is reading.
 */
export function walkDescendants<T extends WalkableNode<T>, C>(
  root: T,
  carried: C,
  visitor: NodeVisitor<T, C>,
): void {
  for (const child of root.namedChildren) {
    if (child === null) {
      continue;
    }
    visitor.at(child, carried);
    const inner = visitor.into(child, carried);
    if (inner !== SKIP_CHILDREN) {
      walkDescendants(child, inner, visitor);
    }
  }
}
