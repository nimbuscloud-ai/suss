/**
 * What each boundary reaches, on both sides of a diff.
 *
 * A reviewer of a pull request cares which requests now touch something
 * they did not touch before, such as a route that started writing to a
 * table or a handler that stopped calling another service. A change deep
 * in a call chain matters only through those requests. So the walk starts
 * at every unit serving a boundary, follows the calls out of it, and
 * collects the boundaries it reaches.
 *
 * It walks the `calls` facts breadth-first instead of running a reach
 * query per boundary, because a project with a thousand routes would run
 * a thousand fixpoints that way.
 */

import { BOUNDARY_ROLE, leavesTheProcess } from "@suss/behavioral-ir";

import { boundariesTouchedBy, boundarySpelling } from "./boundaryReach.js";
import { functionOf, readCallFacts } from "./callFacts.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { Relation } from "@suss/ir-core";
import type { CallEdge, FunctionKey } from "./callFacts.js";

/** One boundary a unit reaches, and the chain of calls that gets there. */
export interface ReachedEffect {
  readonly relation: Relation;
  readonly label: string;
  /** The calls from the unit serving the boundary to the unit that touches this one. */
  readonly through: readonly string[];
}

/** A unit serving a boundary, and what a request through it reaches. */
export interface ServedBoundaryReach {
  readonly summary: BehavioralSummary;
  readonly boundary: string;
  readonly effects: readonly ReachedEffect[];
}

/** What one boundary reaches, on one side of the diff. */
interface Entrypoint {
  readonly boundary: string;
  readonly unit: string;
  readonly file: string;
  readonly reached: Map<string, ReachedEffect>;
}

/** How a boundary and what it reaches changed. */
export interface EntrypointChange {
  readonly key: string;
  readonly boundary: string;
  readonly unit: string;
  readonly file: string;
  /** Whether the whole boundary is new, gone, or was there before. */
  readonly change: "added" | "removed" | "changed";
  readonly gained: readonly ReachedEffect[];
  readonly lost: readonly ReachedEffect[];
}

/**
 * The most functions one walk visits. The visited set already stops
 * cycles. This cap stops a graph so wide that walking it from every
 * boundary would cost more than the answer is worth.
 */
const WALK_LIMIT = 5000;

/**
 * The key that pairs a boundary across the two sides of the diff. It
 * includes the boundary as well as the unit because one function often
 * serves many boundaries: a shared `respond` middleware is the handler of
 * every route that lists it last.
 */
export function entrypointKey(
  file: string,
  unit: string,
  boundary: string,
): string {
  return `${boundary} ${file}::${unit}`;
}

function effectKey(relation: Relation, label: string): string {
  return `${relation} ${label}`;
}

function adjacency(edges: readonly CallEdge[]): Map<FunctionKey, CallEdge[]> {
  const out = new Map<FunctionKey, CallEdge[]>();
  for (const edge of edges) {
    const from = out.get(edge.from);
    if (from === undefined) {
      out.set(edge.from, [edge]);
      continue;
    }
    from.push(edge);
  }
  return out;
}

/**
 * Every boundary reachable from one function, with the shortest chain
 * of calls to each. The boundary the start function serves is left out,
 * because a route does not reach itself.
 */
function reachedFrom(
  start: FunctionKey,
  own: string,
  out: ReadonlyMap<FunctionKey, CallEdge[]>,
  units: ReadonlyMap<FunctionKey, BehavioralSummary[]>,
): Map<string, ReachedEffect> {
  const reached = new Map<string, ReachedEffect>();
  const seen = new Set<FunctionKey>([start]);
  let frontier: Array<{ fn: FunctionKey; through: string[] }> = [
    { fn: start, through: [] },
  ];
  let walked = 0;

  while (frontier.length > 0 && walked < WALK_LIMIT) {
    const next: Array<{ fn: FunctionKey; through: string[] }> = [];
    for (const { fn, through } of frontier) {
      walked += 1;
      for (const summary of units.get(fn) ?? []) {
        for (const touch of boundariesTouchedBy(summary)) {
          if (
            !leavesTheProcess(touch.binding) ||
            (touch.label === own && touch.relation === "provides")
          ) {
            continue;
          }
          // Two variables read through one boundary get a line each.
          const label =
            touch.detail === undefined
              ? touch.label
              : `${touch.label} ${touch.detail}`;
          const key = effectKey(touch.relation, label);
          if (reached.has(key)) {
            continue;
          }
          reached.set(key, { relation: touch.relation, label, through });
        }
      }
      for (const edge of out.get(fn) ?? []) {
        if (seen.has(edge.to)) {
          continue;
        }
        seen.add(edge.to);
        next.push({ fn: edge.to, through: [...through, edge.callee] });
      }
    }
    frontier = next;
  }

  return reached;
}

/** The boundary a unit serves from outside the process, if it serves one. */
function servedBoundary(summary: BehavioralSummary): string | null {
  const binding = summary.identity.boundaryBinding;
  if (
    binding === null ||
    BOUNDARY_ROLE[summary.kind] !== "provider" ||
    !leavesTheProcess(binding)
  ) {
    return null;
  }
  return boundarySpelling(binding);
}

/**
 * What each unit serving a boundary reaches, on one side. The diff and
 * the plain tree both call this, so they agree about what a route reaches.
 */
export function boundaryReach(
  summaries: readonly BehavioralSummary[],
): ServedBoundaryReach[] {
  const facts = readCallFacts(summaries);
  const out = adjacency(facts.edges());
  const reach: ServedBoundaryReach[] = [];

  for (const summary of summaries) {
    const boundary = servedBoundary(summary);
    if (boundary === null) {
      continue;
    }
    const reached = reachedFrom(
      functionOf(summary),
      boundary,
      out,
      facts.units,
    );
    reach.push({ summary, boundary, effects: [...reached.values()] });
  }

  return reach;
}

function entrypointsOf(
  summaries: readonly BehavioralSummary[],
): Map<string, Entrypoint> {
  const entrypoints = new Map<string, Entrypoint>();

  for (const { summary, boundary, effects } of boundaryReach(summaries)) {
    const key = entrypointKey(
      summary.location.file,
      summary.identity.name,
      boundary,
    );
    if (entrypoints.has(key)) {
      continue;
    }
    entrypoints.set(key, {
      boundary,
      unit: summary.identity.name,
      file: summary.location.file,
      reached: new Map(
        effects.map((effect) => [
          effectKey(effect.relation, effect.label),
          effect,
        ]),
      ),
    });
  }

  return entrypoints;
}

function difference(
  from: ReadonlyMap<string, ReachedEffect>,
  against: ReadonlyMap<string, ReachedEffect>,
): ReachedEffect[] {
  const only: ReachedEffect[] = [];
  for (const [key, effect] of from) {
    if (!against.has(key)) {
      only.push(effect);
    }
  }
  return only.sort(
    (a, b) =>
      a.relation.localeCompare(b.relation) || a.label.localeCompare(b.label),
  );
}

const NOTHING: ReadonlyMap<string, ReachedEffect> = new Map();

function whichWay(
  before: Entrypoint | undefined,
  after: Entrypoint | undefined,
): EntrypointChange["change"] {
  if (before === undefined) {
    return "added";
  }
  return after === undefined ? "removed" : "changed";
}

function changeOf(
  before: Entrypoint | undefined,
  after: Entrypoint | undefined,
): EntrypointChange | null {
  const side = after ?? before;
  if (side === undefined) {
    return null;
  }
  const gained = difference(
    after?.reached ?? NOTHING,
    before?.reached ?? NOTHING,
  );
  const lost = difference(
    before?.reached ?? NOTHING,
    after?.reached ?? NOTHING,
  );
  if (gained.length === 0 && lost.length === 0) {
    return null;
  }
  return {
    key: entrypointKey(side.file, side.unit, side.boundary),
    boundary: side.boundary,
    unit: side.unit,
    file: side.file,
    change: whichWay(before, after),
    gained,
    lost,
  };
}

/**
 * Every boundary whose reach changed, sorted by name so two runs over
 * the same change print the same report.
 */
export function reachChanges(
  before: readonly BehavioralSummary[],
  after: readonly BehavioralSummary[],
): EntrypointChange[] {
  const beforeSide = entrypointsOf(before);
  const afterSide = entrypointsOf(after);
  const changes: EntrypointChange[] = [];

  for (const key of new Set([...beforeSide.keys(), ...afterSide.keys()])) {
    const change = changeOf(beforeSide.get(key), afterSide.get(key));
    if (change !== null) {
      changes.push(change);
    }
  }

  return changes.sort(
    (a, b) =>
      a.boundary.localeCompare(b.boundary) || a.unit.localeCompare(b.unit),
  );
}
