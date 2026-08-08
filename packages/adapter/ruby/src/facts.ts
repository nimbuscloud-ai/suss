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

/**
 * What names one discovered unit for the rest of a run.
 *
 * The name is part of the key because the range is lines, and two
 * units can share a line: `field :id, ID; field :name, String` is one
 * line and two units. Keying on the range alone made those one key,
 * and the `entry` relation is a set, so the second unit vanished from
 * it. This is the same thing `summaryIdentity.ts` does when two
 * summaries claim one id: what tells them apart is what they are
 * called.
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
