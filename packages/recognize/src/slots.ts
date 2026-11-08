/**
 * The slots a `slots` declaration states for one access. The compiled
 * storage chain asks this for a chain that has the link, and a pack
 * still written as code asks it with the same declaration, so a call
 * gets the same slots whichever way its pack is written.
 */

import type { StatedSlot } from "@suss/extractor";
import type { DeclaredSlots } from "./chain.js";
import type { ValueOps } from "./ops.js";

/** The columns one access reports, and whether it reads or writes. */
export interface SlotColumns {
  readonly selector: readonly string[];
  readonly fields: readonly string[];
  readonly kind: "read" | "write";
}

/**
 * The value the call writes for each column the access reports, under
 * each path the declaration lists, in the order the source writes them.
 */
export function slotsDeclared(
  input: ValueOps | null,
  says: DeclaredSlots | "none",
  columns: SlotColumns,
): StatedSlot[] {
  if (input === null || says === "none") {
    return [];
  }
  const fieldsOn = says.fieldsOn ?? ["read", "write"];
  const fieldPaths = fieldsOn.includes(columns.kind) ? (says.field ?? []) : [];
  return [
    ...slotsUnder(input, says.selector ?? [], "selector", columns.selector),
    ...slotsUnder(input, fieldPaths, "field", columns.fields),
  ];
}

function slotsUnder(
  input: ValueOps,
  paths: readonly (readonly string[])[],
  slot: StatedSlot["slot"],
  columns: readonly string[],
): StatedSlot[] {
  return paths.flatMap((path) =>
    (valueAt(input, path)?.entries("nothing") ?? []).flatMap((entry) =>
      entry.key !== null && columns.includes(entry.key)
        ? [{ slot, name: entry.key, value: entry.value }]
        : [],
    ),
  );
}

function valueAt(input: ValueOps, path: readonly string[]): ValueOps | null {
  return path.reduce<ValueOps | null>(
    (at, key) => at?.property(key) ?? null,
    input,
  );
}
