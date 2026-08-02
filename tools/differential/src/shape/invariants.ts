// invariants.ts — what a summary set has to be true of, whatever the
// program says.
//
// Execution can only falsify a claim about what runs. Several things a
// summary gets wrong are not claims about a run at all: a summary that
// says nothing while claiming high confidence, two summaries that
// collapse onto one identity, a boundary with no key to pair on. Those
// are wrong against the output alone, so they are checked here and the
// program never enters into it.

import type { BehavioralSummary } from "@suss/behavioral-ir";

export interface InvariantViolation {
  invariant: string;
  detail: string;
}

/** What the generator knows it asked for, which the summaries must reflect. */
export interface ShapeExpectation {
  kind: BehavioralSummary["kind"];
  /** How many boundaries of that kind the program announces. */
  boundaryCount: number;
  /** The name the unit carries in source, when it has one. */
  unitName: string | null;
}

/**
 * A summary large enough that something walked a type's breadth without
 * stopping. Generated programs are a few lines; nothing they can say
 * needs a quarter of a megabyte to say it.
 */
const SUMMARY_BYTE_CAP = 256 * 1024;

const identityKey = (summary: BehavioralSummary): string => {
  const binding = summary.identity.boundaryBinding;
  const boundary =
    binding === null
      ? "none"
      : `${binding.transport}:${JSON.stringify(binding.semantics)}`;
  return `${summary.kind}|${summary.identity.name}|${boundary}`;
};

type Invariant = (
  summaries: BehavioralSummary[],
  expectation: ShapeExpectation,
) => InvariantViolation[];

const violation = (invariant: string, detail: string): InvariantViolation[] => [
  { invariant, detail },
];

const ofKind = (
  summaries: BehavioralSummary[],
  expectation: ShapeExpectation,
): BehavioralSummary[] =>
  summaries.filter((summary) => summary.kind === expectation.kind);

const located = (summaries: BehavioralSummary[]): string =>
  summaries.map((s) => `${s.identity.name} @ ${s.location.file}`).join(", ");

const everyAnnouncedBoundaryIsSummarized: Invariant = (
  summaries,
  expectation,
) => {
  const matching = ofKind(summaries, expectation);
  return matching.length < expectation.boundaryCount
    ? violation(
        "everyAnnouncedBoundaryIsSummarized",
        `the program announces ${expectation.boundaryCount} ${expectation.kind} boundaries and extraction produced ${matching.length}`,
      )
    : [];
};

// Split from the one above so that losing a boundary and reporting one
// twice minimize to different programs; a single count check would
// shrink both to whichever the search reached first.
const noBoundarySummarizedTwice: Invariant = (summaries, expectation) => {
  const matching = ofKind(summaries, expectation);
  return matching.length > expectation.boundaryCount
    ? violation(
        "noBoundarySummarizedTwice",
        `the program announces ${expectation.boundaryCount} ${expectation.kind} boundaries and extraction produced ${matching.length}: ${located(matching)}`,
      )
    : [];
};

const noEmptySummaryAtHighConfidence: Invariant = (summaries) =>
  summaries.flatMap((summary) =>
    summary.transitions.length === 0 &&
    summary.gaps.length === 0 &&
    summary.confidence.level === "high"
      ? violation(
          "noEmptySummaryAtHighConfidence",
          `${summary.identity.name} @ ${summary.location.file} has no transitions and no gaps, at confidence high`,
        )
      : [],
  );

const noTwoSummariesShareAnIdentity: Invariant = (summaries) => {
  const byKey = new Map<string, BehavioralSummary[]>();
  for (const summary of summaries) {
    const key = identityKey(summary);
    byKey.set(key, [...(byKey.get(key) ?? []), summary]);
  }
  return [...byKey.entries()].flatMap(([key, group]) =>
    group.length > 1
      ? violation(
          "noTwoSummariesShareAnIdentity",
          `${group.length} summaries share the identity ${key}, so anything keyed on identity keeps one and drops the rest: ${group
            .map((s) => s.location.file)
            .join(", ")}`,
        )
      : [],
  );
};

const everyBoundaryCanPair: Invariant = (summaries, expectation) =>
  ofKind(summaries, expectation).flatMap((summary) => {
    const binding = summary.identity.boundaryBinding;
    if (binding === null) {
      return violation(
        "everyBoundaryCanPair",
        `${summary.identity.name} is a ${summary.kind} with no boundary binding, so nothing can pair with it`,
      );
    }
    if (binding.semantics.name !== "rest") {
      return [];
    }
    const { method, path } = binding.semantics;
    return method === "" || path === ""
      ? violation(
          "everyBoundaryCanPair",
          `${summary.identity.name} binds to rest with method ${JSON.stringify(method)} and path ${JSON.stringify(path)}, which pairs with nothing`,
        )
      : [];
  });

const noRunawaySummary: Invariant = (summaries) =>
  summaries.flatMap((summary) => {
    const bytes = JSON.stringify(summary).length;
    return bytes > SUMMARY_BYTE_CAP
      ? violation(
          "noRunawaySummary",
          `${summary.identity.name} serializes to ${bytes} bytes, past the ${SUMMARY_BYTE_CAP} cap`,
        )
      : [];
  });

const aNamedUnitKeepsItsName: Invariant = (summaries, expectation) => {
  if (expectation.unitName === null) {
    return [];
  }
  const matching = ofKind(summaries, expectation);
  if (
    matching.length === 0 ||
    matching.some((s) => s.identity.name === expectation.unitName)
  ) {
    return [];
  }
  return violation(
    "aNamedUnitKeepsItsName",
    `the unit is written as ${expectation.unitName} in source, and extraction reports ${matching
      .map((s) => JSON.stringify(s.identity.name))
      .join(", ")}`,
  );
};

export const INVARIANTS: Record<string, Invariant> = {
  everyAnnouncedBoundaryIsSummarized,
  noBoundarySummarizedTwice,
  noEmptySummaryAtHighConfidence,
  noTwoSummariesShareAnIdentity,
  everyBoundaryCanPair,
  noRunawaySummary,
  aNamedUnitKeepsItsName,
};

export function checkInvariants(
  summaries: BehavioralSummary[],
  expectation: ShapeExpectation,
): InvariantViolation[] {
  return Object.values(INVARIANTS).flatMap((invariant) =>
    invariant(summaries, expectation),
  );
}
