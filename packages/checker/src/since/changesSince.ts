/**
 * What moved between an earlier run and a later one over the same
 * project: which findings are new, which went away, and which
 * boundaries the code changed at.
 *
 * `suss check --since` prints this, and a hook that watches an agent
 * edit reads it after every edit to decide what to say. A boundary
 * counts as changed when a unit on it was added, removed or now behaves
 * differently. It also counts when a changed path of any unit reads,
 * writes or calls across it, which is what puts a table on the list
 * when a handler starts writing a new column.
 */

import {
  diffSummaries,
  summaryIdentifier,
  summaryRef,
} from "@suss/behavioral-ir";

import { boundaryKeyOf, findingIdentity } from "./findingIdentity.js";

import type {
  BehavioralSummary,
  Finding,
  Transition,
} from "@suss/behavioral-ir";

export interface FindingsSince {
  /** In the later run and not the earlier one. */
  added: Finding[];
  /** In the earlier run and not the later one. */
  resolved: Finding[];
}

/** Findings new since the earlier run, and the ones it had that are gone. */
export function findingsSince(
  earlier: readonly Finding[],
  later: readonly Finding[],
): FindingsSince {
  const before = new Set(earlier.map(findingIdentity));
  const after = new Set(later.map(findingIdentity));
  return {
    added: later.filter((finding) => !before.has(findingIdentity(finding))),
    resolved: earlier.filter((finding) => !after.has(findingIdentity(finding))),
  };
}

export interface ChangedBoundary {
  /** The key findings and `.sussignore` rules use for this boundary. */
  key: string;
  /** The units whose behavior at this boundary moved, as `file::name`. */
  units: string[];
}

/** One unit that moved, and the transitions that did. */
interface MovedUnit {
  sides: BehavioralSummary[];
  transitions: Transition[];
}

/**
 * The boundaries the code changed at between two sets of summaries,
 * sorted by key. A unit is matched across the two sets by its summary
 * id, and compared with `diffSummaries`, so a line that moved without
 * changing what the unit does is not a change.
 */
export function changedBoundaries(
  before: readonly BehavioralSummary[],
  after: readonly BehavioralSummary[],
): ChangedBoundary[] {
  const beforeById = byUnit(before);
  const afterById = byUnit(after);
  const unitsByKey = new Map<string, Set<string>>();

  for (const id of new Set([...beforeById.keys(), ...afterById.keys()])) {
    const moved = unitMoved(beforeById.get(id), afterById.get(id));
    if (moved === null) {
      continue;
    }

    for (const key of boundariesTouched(moved)) {
      const units = unitsByKey.get(key) ?? new Set<string>();
      for (const side of moved.sides) {
        units.add(summaryRef(side));
      }
      unitsByKey.set(key, units);
    }
  }

  return [...unitsByKey]
    .map(([key, units]) => ({ key, units: [...units].sort() }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

export interface ChangesSince extends FindingsSince {
  changedBoundaries: ChangedBoundary[];
}

/** A run's summaries and the findings the checker reported over them. */
export interface CheckedRun {
  summaries: readonly BehavioralSummary[];
  findings: readonly Finding[];
}

/** Everything that moved between two runs over one project. */
export function changesSince(
  earlier: CheckedRun,
  later: CheckedRun,
): ChangesSince {
  return {
    ...findingsSince(earlier.findings, later.findings),
    changedBoundaries: changedBoundaries(earlier.summaries, later.summaries),
  };
}

function byUnit(
  summaries: readonly BehavioralSummary[],
): Map<string, BehavioralSummary> {
  return new Map(
    summaries.map((summary) => [
      `${summary.kind} ${summaryIdentifier(summary)}`,
      summary,
    ]),
  );
}

/**
 * The unit on both sides and its moved transitions, or null when it
 * behaves the same. A unit that moved to another route with the same
 * transitions has changed at both routes.
 */
function unitMoved(
  before: BehavioralSummary | undefined,
  after: BehavioralSummary | undefined,
): MovedUnit | null {
  if (before === undefined || after === undefined) {
    const only = (before ?? after) as BehavioralSummary;
    return { sides: [only], transitions: only.transitions };
  }

  const diff = diffSummaries(before, after);
  const transitions = [
    ...diff.addedTransitions,
    ...diff.removedTransitions,
    ...diff.changedTransitions.flatMap((pair) => [pair.before, pair.after]),
  ];
  if (transitions.length === 0 && ownKey(before) === ownKey(after)) {
    return null;
  }
  return { sides: [before, after], transitions };
}

function ownKey(summary: BehavioralSummary): string | null {
  const binding = summary.identity.boundaryBinding;
  return binding === null ? null : boundaryKeyOf(binding);
}

/** The unit's own boundary, and every boundary its moved paths cross. */
function boundariesTouched(moved: MovedUnit): Set<string> {
  const keys = new Set<string>();
  for (const side of moved.sides) {
    const key = ownKey(side);
    if (key !== null) {
      keys.add(key);
    }
  }

  for (const transition of moved.transitions) {
    for (const effect of transition.effects) {
      if (effect.type === "interaction") {
        keys.add(boundaryKeyOf(effect.binding));
      }
    }
  }
  return keys;
}
