/**
 * The calls where the ops over the facts are allowed to answer a pack
 * differently from the ops over ts-morph nodes, each with the reason.
 * The list only shrinks: a difference fixed in the fact ops comes off.
 */

import type { OpsDifference } from "./opsGate.js";

interface KnownDifference {
  readonly pack: string;
  /** The start of the call's source text. */
  readonly call: string;
  readonly reason: string;
}

const KNOWN: readonly KnownDifference[] = [];

export function isKnownDifference(difference: OpsDifference): boolean {
  return KNOWN.some(
    (known) =>
      known.pack === difference.pack && difference.call.startsWith(known.call),
  );
}
