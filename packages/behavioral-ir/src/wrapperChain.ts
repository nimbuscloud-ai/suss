/**
 * The summary each wrapper on a unit's chain refers to.
 *
 * A unit records the wrappers registered around it as file-and-name
 * references, and each wrapper's behavior is in its own summary. Any
 * reader that wants the effects along a request, and not only the
 * unit's own outcomes, follows the chain to those summaries through
 * these functions.
 */

import { readWrapperMetadata } from "./metadata.js";

import type { BehavioralSummary, WrapperReference } from "./index.js";

/** A run's summaries keyed by file and name, the two fields a wrapper reference gives. */
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
 * none. Two inline functions registered in one file can share a name,
 * and the line tells them apart.
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

/**
 * The summaries of the wrappers around each unit, for a whole run. A
 * reference without a summary in the run is left out, as happens for
 * middleware imported from a package the extraction never walked.
 */
export function wrappersAround(
  summaries: readonly BehavioralSummary[],
): (unit: BehavioralSummary) => BehavioralSummary[] {
  const index = wrapperIndex(summaries);
  return (unit) =>
    wrapperChain(unit).flatMap((reference) => {
      const found = wrapperFor(index, reference);
      return found === undefined ? [] : [found];
    });
}
