/**
 * The recursion the adapters use to find a declaration wherever the
 * language allows one to be written.
 *
 * A declaration can go anywhere a statement can, and every language has
 * more places for a statement than anyone remembers to list. So an adapter
 * does not list the containers to descend into. The walk visits every
 * named child, and the adapter only lists the nodes whose body belongs to
 * what they declare, because that list is short and the grammar already
 * has a node type for each.
 */

/** The one thing the walk needs from a parse tree node. */
export interface WalkableNode<T> {
  readonly namedChildren: ReadonlyArray<T | null>;
}

/**
 * Returned by `into` for a node whose children the walk should leave
 * unread, such as one whose body belongs to what it declares. It is a
 * symbol so it cannot collide with any value a caller passes down.
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
