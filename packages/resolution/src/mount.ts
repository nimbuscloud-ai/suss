/**
 * Mount composition, shared between adapters. An adapter states one
 * fact per mount call, `mounted(child, parent, prefix)`, however its
 * language spells the call: Express's `app.use(prefix, router)`,
 * FastAPI's `app.include_router(router, prefix=...)`. This module
 * composes those edges into the full prefix a child's routes are
 * served under, so both adapters compute the same paths.
 *
 * The composition is a function over the edge set rather than a
 * datalog rule because a rule head cannot build a new atom, and a
 * path-concatenating closure would not terminate on a mount cycle:
 * the string grows on every round. Here a cycle is an abstention.
 */

export interface MountEdge {
  parentId: string;
  prefix: string;
}

/** Every mount edge, keyed by the mounted child. */
export type MountEdges = ReadonlyMap<string, readonly MountEdge[]>;

/**
 * Join a mount prefix onto a path written with its own leading slash.
 * A root prefix strips to nothing, so mounting under "/" leaves the
 * path as written.
 */
export function joinMountedPath(prefix: string, path: string): string {
  const trimmed = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return trimmed === "" ? path : trimmed + path;
}

/**
 * Every full prefix the child's mount chains compose to, one per
 * mount, which is what one-boundary-per-mount reads. Null when a
 * chain cannot be stated: a cycle, or an ancestor whose own paths
 * cannot be stated. An unmounted child composes to [""].
 */
export function mountPathsOf(
  edges: MountEdges,
  childId: string,
): readonly string[] | null {
  return pathsOf(edges, new Map(), childId, new Set());
}

/**
 * The one prefix every mount chain agrees on. "" for an unmounted
 * child, null when a cycle or a disagreement leaves nothing to say.
 *
 * Agreement is checked on the composed result, not the literal prefix
 * a mount call gives: two mounts spelling the identical local prefix
 * still land at different full paths when one parent is itself
 * mounted somewhere the other is not.
 */
export function agreedMountPrefix(
  edges: MountEdges,
  childId: string,
): string | null {
  const paths = mountPathsOf(edges, childId);
  if (paths === null) {
    return null;
  }
  const distinct = new Set(paths);
  const only = [...distinct][0];
  return distinct.size === 1 && only !== undefined ? only : null;
}

function pathsOf(
  edges: MountEdges,
  memo: Map<string, readonly string[] | null>,
  childId: string,
  visiting: Set<string>,
): readonly string[] | null {
  const cached = memo.get(childId);
  if (cached !== undefined) {
    return cached;
  }

  if (visiting.has(childId)) {
    memo.set(childId, null);
    return null;
  }

  const own = edges.get(childId);
  if (own === undefined || own.length === 0) {
    memo.set(childId, [""]);
    return [""];
  }

  visiting.add(childId);
  const composed = new Set<string>();
  let unstated = false;
  for (const edge of own) {
    const parentPaths = pathsOf(edges, memo, edge.parentId, visiting);
    if (parentPaths === null) {
      unstated = true;
      break;
    }

    for (const parentPath of parentPaths) {
      composed.add(joinMountedPath(parentPath, edge.prefix));
    }
  }
  visiting.delete(childId);

  const result = unstated ? null : [...composed];
  memo.set(childId, result);
  return result;
}
