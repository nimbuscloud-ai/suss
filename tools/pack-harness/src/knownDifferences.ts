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

const NO_CLASS_AT =
  "typeorm reads the table off the entity class through classAt, which the fact ops leave out until typeorm moves onto them";

const NO_SELECTOR_READS =
  "zustand reads a selector through namedCallee and parameterReadsAt, which the fact ops leave out until zustand moves onto them";

const KNOWN: readonly KnownDifference[] = [
  { pack: "typeorm", call: "this.orders.", reason: NO_CLASS_AT },
  { pack: "typeorm", call: "this.lines.", reason: NO_CLASS_AT },
  { pack: "zustand", call: "useAppStore((s)", reason: NO_SELECTOR_READS },
];

export function isKnownDifference(difference: OpsDifference): boolean {
  return KNOWN.some(
    (known) =>
      known.pack === difference.pack && difference.call.startsWith(known.call),
  );
}
