// invariants.ts: what a summary set has to be true of, whatever the
// program says.
//
// Execution can only falsify a claim about what runs. Several things a
// summary gets wrong are not claims about a run at all: a summary that
// says nothing while claiming high confidence, two summaries that
// collapse onto one identity, a boundary with no key to pair on. Those
// are wrong against the output alone, so they are checked here and the
// program never enters into it.

import { canPair, displayLabel } from "@suss/ir-core";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { ExpectedConfigRead } from "./envShape.js";

export interface InvariantViolation {
  invariant: string;
  detail: string;
}

/** What the generator knows it asked for, which the summaries must reflect. */
export interface ShapeExpectation {
  kind: BehavioralSummary["kind"];
  /** How many boundaries of that kind the program announces. */
  boundaryCount: number;
  unitName: string | null;
  /**
   * The runtime configuration the program reads. Left out by families
   * that read none, and then the config invariants say nothing.
   */
  configReads?: ExpectedConfigRead[];
  /**
   * The GraphQL field the program says this resolver serves. A null
   * `typeName` is a program that gives the field but not the type it
   * belongs to, where the answer is a binding with no type plus a gap
   * saying why, rather than a type nothing in the source supports.
   */
  resolver?: { typeName: string | null; fieldName: string };
  /**
   * The path a package publishes the unit under. Nothing pairs a call
   * site with a provider that has no path to name it by.
   */
  exportPath?: string[];
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

    // The registry covers every protocol, so a keyless boundary in a
    // protocol added later fails here instead of passing unseen.
    if (canPair(binding)) {
      return [];
    }

    // A program that gives no type has none to bind, so a resolver
    // binding with no type is what the summary should have.
    if (
      binding.semantics.name === "graphql-resolver" &&
      expectation.resolver?.typeName === null
    ) {
      return [];
    }

    return violation(
      "everyBoundaryCanPair",
      `${summary.identity.name} binds to ${displayLabel(binding)}, which pairs with nothing`,
    );
  });

const saysWhatItCouldNotRead = (summary: BehavioralSummary): boolean =>
  summary.gaps.some((gap) => gap.type === "unreadOutcome");

/**
 * Whether this summary matches the field the program states.
 *
 * A program that gives no type should produce a binding with no type
 * either, and only when the summary also says the type went unread. An
 * empty type with nothing to explain it looks the same as an extraction
 * that dropped the name on the way.
 */
function bindsToTheWantedField(
  summary: BehavioralSummary,
  wanted: NonNullable<ShapeExpectation["resolver"]>,
): boolean {
  const binding = summary.identity.boundaryBinding;
  if (binding === null || binding.semantics.name !== "graphql-resolver") {
    return false;
  }
  if (binding.semantics.fieldName !== wanted.fieldName) {
    return false;
  }
  if (wanted.typeName === null) {
    return (
      binding.semantics.typeName === null && saysWhatItCouldNotRead(summary)
    );
  }
  return binding.semantics.typeName === wanted.typeName;
}

const aResolverBindsToTheFieldItAnswers: Invariant = (
  summaries,
  expectation,
) => {
  const wanted = expectation.resolver;
  if (wanted === undefined) {
    return [];
  }
  const matching = ofKind(summaries, expectation);
  const named = matching.filter((summary) =>
    bindsToTheWantedField(summary, wanted),
  );
  const field =
    wanted.typeName === null
      ? `${wanted.fieldName}, on a type it does not name,`
      : `${wanted.typeName}.${wanted.fieldName} and`;
  return named.length > 0
    ? []
    : violation(
        "aResolverBindsToTheFieldItAnswers",
        `the program answers ${field} nothing binds to that field the way the program states it, so a query for it pairs with the wrong thing or with nothing (bindings: ${
          matching
            .map((s) => JSON.stringify(s.identity.boundaryBinding?.semantics))
            .join(", ") || "none"
        })`,
      );
};

const everyExportKeepsItsPath: Invariant = (summaries, expectation) => {
  const wanted = expectation.exportPath;
  if (wanted === undefined) {
    return [];
  }
  const matching = ofKind(summaries, expectation);
  const carrying = matching.filter((summary) => {
    const binding = summary.identity.boundaryBinding;
    return (
      binding !== null &&
      binding.semantics.name === "function-call" &&
      JSON.stringify(binding.semantics.exportPath ?? []) ===
        JSON.stringify(wanted)
    );
  });
  return carrying.length > 0
    ? []
    : violation(
        "everyExportKeepsItsPath",
        `the package publishes ${wanted.join(".")} and nothing binds under that path, so a call site pairs with nothing (bindings: ${
          matching
            .map((s) => JSON.stringify(s.identity.boundaryBinding?.semantics))
            .join(", ") || "none"
        })`,
      );
};

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

const configReadsIn = (
  summaries: BehavioralSummary[],
): Array<{ name: string; defaulted: boolean }> =>
  summaries.flatMap((summary) =>
    summary.transitions.flatMap((transition) =>
      (transition.effects ?? []).flatMap((effect) =>
        effect.type === "interaction" &&
        effect.interaction.class === "config-read"
          ? [
              {
                name: effect.interaction.name,
                defaulted: effect.interaction.defaulted === true,
              },
            ]
          : [],
      ),
    ),
  );

const everyConfigReadIsReported: Invariant = (summaries, expectation) => {
  const reported = configReadsIn(summaries);
  return (expectation.configReads ?? []).flatMap((expected) =>
    reported.some((read) => read.name === expected.name)
      ? []
      : violation(
          "everyConfigReadIsReported",
          `the program reads ${expected.name} off process.env and no summary reports it, so nothing deploying this unit learns it needs the variable (reported: ${
            reported.map((read) => read.name).join(", ") || "nothing"
          })`,
        ),
  );
};

const aDefaultedReadSaysSo: Invariant = (summaries, expectation) => {
  const reported = configReadsIn(summaries);
  return (expectation.configReads ?? []).flatMap((expected) => {
    const found = reported.find((read) => read.name === expected.name);
    if (found === undefined || found.defaulted === expected.defaulted) {
      return [];
    }
    return violation(
      "aDefaultedReadSaysSo",
      `the program ${expected.defaulted ? "defaults" : "does not default"} ${expected.name} and the summary says defaulted=${found.defaulted}`,
    );
  });
};

export const INVARIANTS: Record<string, Invariant> = {
  everyAnnouncedBoundaryIsSummarized,
  noBoundarySummarizedTwice,
  noEmptySummaryAtHighConfidence,
  noTwoSummariesShareAnIdentity,
  everyBoundaryCanPair,
  noRunawaySummary,
  aNamedUnitKeepsItsName,
  aResolverBindsToTheFieldItAnswers,
  everyExportKeepsItsPath,
  everyConfigReadIsReported,
  aDefaultedReadSaysSo,
};

export function checkInvariants(
  summaries: BehavioralSummary[],
  expectation: ShapeExpectation,
): InvariantViolation[] {
  return Object.values(INVARIANTS).flatMap((invariant) =>
    invariant(summaries, expectation),
  );
}
