/**
 * wrapperChain.ts: the summary each wrapper on a unit's chain points at.
 *
 * A unit records the wrappers registered around it as file-and-name
 * references, and what each of them does is in its own summary. Every
 * reader that wants the effects along a request, rather than the
 * unit's own outcomes alone, follows the chain to those summaries, so
 * the pairing lives here instead of once per reader.
 */

import { readWrapperMetadata } from "./metadata.js";

import type { BehavioralSummary, WrapperReference } from "./index.js";

/** A run's summaries by the file and name a wrapper reference spells. */
export type WrapperIndex = ReadonlyMap<string, BehavioralSummary[]>;

function keyOf(file: string, name: string): string {
  return `${file}::${name}`;
}

export function wrapperIndex(
  summaries: readonly BehavioralSummary[],
): WrapperIndex {
  const byKey = new Map<string, BehavioralSummary[]>();
  for (const summary of summaries) {
    const key = keyOf(summary.location.file, summary.identity.name);
    const sharing = byKey.get(key);
    if (sharing === undefined) {
      byKey.set(key, [summary]);
      continue;
    }
    sharing.push(summary);
  }
  return byKey;
}

/**
 * The summary this reference points at, or undefined when the run has
 * none. Two functions written out at their registrations in one file go
 * by the same name, and the line is what tells them apart.
 */
export function wrapperFor(
  index: WrapperIndex,
  reference: WrapperReference,
): BehavioralSummary | undefined {
  const sharing = index.get(keyOf(reference.file, reference.name)) ?? [];
  if (reference.line === undefined) {
    return sharing[0];
  }
  return (
    sharing.find((one) => one.location.range.start === reference.line) ??
    sharing[0]
  );
}

/** The chain recorded on a unit, in the order it runs. */
export function wrapperChain(
  summary: BehavioralSummary,
): readonly WrapperReference[] {
  return readWrapperMetadata(summary)?.applied ?? [];
}
