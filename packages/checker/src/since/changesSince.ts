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
 * when a handler starts writing a new column. A deployable's
 * environment counts as changed when the variables its template
 * declares change, which no transition shows.
 */

import {
  declaredEnvVars,
  diffSummaries,
  interactionDetail,
  isRuntimeConfigProvider,
  summaryIdentifier,
  summaryRef,
} from "@suss/behavioral-ir";
import { boundaryLabel, labelWithDetail } from "@suss/ir-core";

import { boundaryKeyOf, findingIdentity } from "./findingIdentity.js";

import type {
  BehavioralSummary,
  BoundaryBinding,
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
  /**
   * The boundary as a person reads it, with the names whose reads or
   * declarations moved: `runtime-config ACCOUNTS_REGION`,
   * `GET /accounts/{id}`. Null for a boundary with no name of its own
   * and no name moving on it, such as a call from one function in the
   * project to another; `units` says which functions moved.
   */
  label: string | null;
  /** The units whose behavior at this boundary moved, as `file::name`. */
  units: string[];
}

/** One unit that moved, and its paths that moved on each side. */
interface MovedUnit {
  /** The unit in the earlier run, or undefined when it is new. */
  earlier: BehavioralSummary | undefined;
  /** The unit in the later run, or undefined when it is gone. */
  later: BehavioralSummary | undefined;
  before: Transition[];
  after: Transition[];
}

/** What moved at one key, gathered across every unit that touched it. */
interface Touched {
  binding: BoundaryBinding;
  units: Set<string>;
  /** Names read or declared on each side, from the paths and declarations that moved. */
  earlier: Set<string>;
  later: Set<string>;
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
  const touched = new Map<string, Touched>();

  for (const id of new Set([...beforeById.keys(), ...afterById.keys()])) {
    const moved = unitMoved(beforeById.get(id), afterById.get(id));
    if (moved === null) {
      continue;
    }
    recordTouches(moved, touched);
  }

  return [...touched]
    .map(([key, one]) => ({
      key,
      label: labelOf(one),
      units: [...one.units].sort(),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * A boundary's own label, followed by the names that came or went on
 * it. A boundary with no label of its own and no name moving on it has
 * none, since the only thing to say is which function changed.
 */
function labelOf(touched: Touched): string | null {
  const moved = [
    ...[...touched.later].filter((name) => !touched.earlier.has(name)),
    ...[...touched.earlier].filter((name) => !touched.later.has(name)),
  ].sort();
  if (moved.length > 0) {
    return labelWithDetail(touched.binding, moved.join(", "));
  }
  return boundaryLabel(touched.binding);
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
 * The unit on both sides and its moved paths, or null when it behaves
 * the same and declares the same. A unit that moved to another route
 * with the same transitions has changed at both routes.
 */
function unitMoved(
  before: BehavioralSummary | undefined,
  after: BehavioralSummary | undefined,
): MovedUnit | null {
  if (before === undefined || after === undefined) {
    return {
      earlier: before,
      later: after,
      before: before?.transitions ?? [],
      after: after?.transitions ?? [],
    };
  }

  const diff = diffSummaries(before, after);
  const moved = {
    earlier: before,
    later: after,
    before: [
      ...diff.removedTransitions,
      ...diff.changedTransitions.map((pair) => pair.before),
    ],
    after: [
      ...diff.addedTransitions,
      ...diff.changedTransitions.map((pair) => pair.after),
    ],
  };
  if (
    moved.before.length + moved.after.length === 0 &&
    ownKey(before) === ownKey(after) &&
    sameNames(declaredNames(before), declaredNames(after))
  ) {
    return null;
  }
  return moved;
}

function ownKey(summary: BehavioralSummary): string | null {
  const binding = summary.identity.boundaryBinding;
  return binding === null ? null : boundaryKeyOf(binding);
}

/** The variables a runtime's template declares for it, and none for any other unit. */
function declaredNames(summary: BehavioralSummary): Set<string> {
  return isRuntimeConfigProvider(summary)
    ? new Set(declaredEnvVars(summary).keys())
    : new Set();
}

function sameNames(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((name) => b.has(name));
}

/**
 * The unit's own boundary, with the variables it declares, and every
 * boundary its moved paths cross, with the names they read.
 */
function recordTouches(moved: MovedUnit, touched: Map<string, Touched>): void {
  const sides = [
    [moved.earlier, "earlier"],
    [moved.later, "later"],
  ] as const;
  const units = sides.flatMap(([side]) =>
    side === undefined ? [] : [summaryRef(side)],
  );

  for (const [side, which] of sides) {
    const binding = side?.identity.boundaryBinding ?? null;
    if (side === undefined || binding === null) {
      continue;
    }
    const at = touchedAt(touched, boundaryKeyOf(binding), binding, units);
    for (const name of declaredNames(side)) {
      at[which].add(name);
    }
  }

  for (const [paths, which] of [
    [moved.before, "earlier"],
    [moved.after, "later"],
  ] as const) {
    for (const transition of paths) {
      for (const effect of transition.effects) {
        if (effect.type !== "interaction") {
          continue;
        }
        const at = touchedAt(
          touched,
          boundaryKeyOf(effect.binding),
          effect.binding,
          units,
        );
        const detail = interactionDetail(effect.interaction);
        if (detail !== undefined) {
          at[which].add(detail);
        }
      }
    }
  }
}

function touchedAt(
  touched: Map<string, Touched>,
  key: string,
  binding: BoundaryBinding,
  units: string[],
): Touched {
  const at = touched.get(key) ?? {
    binding,
    units: new Set<string>(),
    earlier: new Set<string>(),
    later: new Set<string>(),
  };
  for (const unit of units) {
    at.units.add(unit);
  }
  touched.set(key, at);
  return at;
}
