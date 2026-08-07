// facts.ts: what discovery hands to the shared fact store, per
// facts-and-rules.md's Layer 1 contract ("discover units, emit
// summaries, emit these facts").
//
// `entry` reuses the existing relation name and shape (unit is a
// pack-discovered entry point) so a Ruby-discovered field is an entry
// the same way a Python route or a TypeScript handler is. v0 emits
// nothing beyond it: requires are not resolved, so there is no
// import-style relation to record the way Python's `pyImport` does.

import type { Database } from "@suss/datalog";

export function unitKey(
  filePath: string,
  range: { start: number; end: number },
): string {
  return `${filePath}:${range.start}-${range.end}`;
}

export function emitEntryFact(
  db: Database,
  filePath: string,
  range: { start: number; end: number },
): void {
  db.add("entry", [unitKey(filePath, range)]);
}
