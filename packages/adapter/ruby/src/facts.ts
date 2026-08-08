// facts.ts: what discovery hands to the shared fact store.
//
// This is the Layer 1 contract: discover units, emit summaries, emit
// these facts.
//
// `entry` reuses the existing relation name and shape, where the unit
// is a pack-discovered entry point, so a Ruby-discovered field is an
// entry the same way a Python route or a TypeScript handler is. This
// slice emits nothing beyond it. Requires are not resolved, so there is
// no import-style relation to record the way Python's `pyImport` does.

import type { Database } from "@suss/datalog";

/**
 * The name is part of the key because the range is measured in lines, two
 * units can start on the same line, and `entry` is a set, so keying on the range
 * alone would drop one of them.
 */
export function unitKey(
  filePath: string,
  range: { start: number; end: number },
  name: string,
): string {
  return `${filePath}:${range.start}-${range.end}#${name}`;
}

export function emitEntryFact(
  db: Database,
  filePath: string,
  range: { start: number; end: number },
  name: string,
): void {
  db.add("entry", [unitKey(filePath, range, name)]);
}
