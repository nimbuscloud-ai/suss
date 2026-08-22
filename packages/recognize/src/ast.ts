/**
 * The floor: a link that reads the adapter's own syntax tree.
 *
 * A pack that outgrows the ops still gets the tree, and this is the
 * only door to it. Going through a separate import puts the decision in
 * the diff, and `astLink` marks the link so the pack health report says
 * which packs went through, the way it says which declare no version.
 * Allowed, observable, and slightly inconvenient.
 *
 * The node comes back as `unknown` because this package does not read
 * any one language. A pack casts it to the adapter it was written
 * against, and that cast is how the pack says which adapter it needs.
 */

import type { LinkFunction } from "./chain.js";
import type { CallOps } from "./ops.js";

/**
 * The ops an adapter implements when it can hand out its own nodes. The
 * extra member is here rather than on `CallOps` so that a pack reaching
 * for a node has to import this module first.
 */
export interface AstCapableOps extends CallOps {
  /** The adapter's own node for the call in hand. */
  ast(): unknown;
}

/**
 * A link answered by reading the call's own node. `read` is handed the
 * node and whatever the link would have been handed anyway.
 */
export function astLink<A extends unknown[], R>(
  read: (node: unknown, ...given: A) => R,
): LinkFunction<[...A, CallOps], R> {
  const link = (...args: [...A, CallOps]): R => {
    const ops = args[args.length - 1] as AstCapableOps;
    const given = args.slice(0, -1) as unknown as A;
    return read(ops.ast(), ...given);
  };
  return Object.assign(link, { reachesAst: true as const });
}
