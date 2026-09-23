/**
 * A link that reads the adapter's own syntax tree, for a pack the ops
 * cannot serve.
 *
 * This is the only way a pack reaches the tree. It needs a separate
 * import, so a pack that starts using it shows up in the diff. `astLink`
 * also marks the link, and the pack health report lists every pack that
 * used it, the same way it lists packs that declare no version.
 *
 * The node comes back as `unknown` because this package does not read
 * any one language. A pack casts it to the adapter it was written
 * against, and that cast is how the pack says which adapter it needs.
 */

import type { AstCapableOps, CallOps } from "@suss/extractor";
import type { LinkFunction } from "./chain.js";

/**
 * A link that reads the call's own node. `read` gets the node first,
 * then the arguments the link would have received anyway.
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
