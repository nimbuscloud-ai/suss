// equivalence.ts: the oracle for programs that mean the same thing.
//
// One behavior can be written many ways: a concise arrow or a block
// arrow, a name or a property read, a direct call or one through a
// factory. Whichever way it is written, the summary should say the same
// thing. So the generator emits a pair, a variant and the plainest
// spelling of the same behavior, and this compares the two summary
// sets. Everything is compared except where a value names a position in
// source, since the two programs are different text.

import type { BehavioralSummary } from "@suss/behavioral-ir";

export interface SummaryDifference {
  /** Where in the summary the two disagree, as a dotted path. */
  path: string;
  baseline: string;
  variant: string;
}

/**
 * Fields that say where something sits rather than what it does. A
 * summary's file, ranges, and transition ids differ between two
 * spellings by construction; an export path differs when the pair is a
 * named export against a default one.
 */
const POSITIONAL_FIELDS = new Set(["location", "exportPath", "id", "metadata"]);

type Plain =
  | string
  | number
  | boolean
  | null
  | Plain[]
  | { [key: string]: Plain };

function stripPositions(value: unknown): Plain {
  if (Array.isArray(value)) {
    return value.map(stripPositions);
  }
  if (value === null || typeof value !== "object") {
    return (value ?? null) as Plain;
  }
  const out: { [key: string]: Plain } = {};
  for (const [key, inner] of Object.entries(value)) {
    if (POSITIONAL_FIELDS.has(key)) {
      continue;
    }
    out[key] = stripPositions(inner);
  }
  return out;
}

/** A summary with every positional field removed, transitions in a stable order. */
export function normalizeSummary(summary: BehavioralSummary): Plain {
  const stripped = stripPositions(summary) as { [key: string]: Plain };
  const transitions = stripped.transitions;
  if (Array.isArray(transitions)) {
    stripped.transitions = [...transitions].sort((left, right) =>
      JSON.stringify(left) < JSON.stringify(right) ? -1 : 1,
    );
  }
  return stripped;
}

function differences(
  baseline: Plain,
  variant: Plain,
  path: string,
): SummaryDifference[] {
  if (JSON.stringify(baseline) === JSON.stringify(variant)) {
    return [];
  }
  const bothRecords =
    baseline !== null &&
    variant !== null &&
    typeof baseline === "object" &&
    typeof variant === "object" &&
    !Array.isArray(baseline) &&
    !Array.isArray(variant);
  if (bothRecords) {
    const keys = new Set([...Object.keys(baseline), ...Object.keys(variant)]);
    return [...keys].flatMap((key) =>
      differences(
        (baseline as { [k: string]: Plain })[key] ?? null,
        (variant as { [k: string]: Plain })[key] ?? null,
        path === "" ? key : `${path}.${key}`,
      ),
    );
  }
  return [
    {
      path: path === "" ? "summary" : path,
      baseline: JSON.stringify(baseline),
      variant: JSON.stringify(variant),
    },
  ];
}

/**
 * Where two summary sets for the same behavior disagree. Sets are
 * paired by position after a stable sort, which is enough while a
 * generated program announces one boundary; a differing count is
 * reported as its own disagreement.
 */
export interface EquivalenceOptions {
  /**
   * Dotted paths whose disagreement is expected for this pair. An
   * export route that renames what it exports leaves two defensible
   * answers for the summary's name, so that pair ignores the name and
   * the naming invariant carries it instead.
   */
  ignorePaths?: string[];
}

export function summarySetDifferences(
  baseline: BehavioralSummary[],
  variant: BehavioralSummary[],
  options: EquivalenceOptions = {},
): SummaryDifference[] {
  if (baseline.length !== variant.length) {
    return [
      {
        path: "summaries.length",
        baseline: String(baseline.length),
        variant: String(variant.length),
      },
    ];
  }
  const order = (summaries: BehavioralSummary[]): Plain[] =>
    summaries
      .map(normalizeSummary)
      .sort((left, right) =>
        JSON.stringify(left) < JSON.stringify(right) ? -1 : 1,
      );

  const left = order(baseline);
  const right = order(variant);
  const ignored = options.ignorePaths ?? [];
  return left
    .flatMap((summary, index) =>
      differences(summary, right[index] ?? null, `summaries[${index}]`),
    )
    .filter(
      (difference) => !ignored.some((path) => difference.path.endsWith(path)),
    );
}
