/**
 * What each boundary reaches, on both sides of a diff.
 *
 * A unit that changed somewhere down a call chain is not what a reader
 * of a pull request wants to hear about. They want to know which
 * requests now touch something they did not before: a route that
 * started writing to a table, a handler that stopped calling another
 * service. So the walk starts at every unit serving a boundary, follows
 * the calls out of it, and collects the boundaries it comes to.
 *
 * It walks the `calls` facts breadth-first rather than asking a reach
 * query per boundary, since a project with a thousand routes would run
 * a thousand fixpoints that way.
 */

import { BOUNDARY_ROLE, leavesTheProcess } from "@suss/behavioral-ir";

import { boundariesTouchedBy, boundarySpelling } from "./boundaryReach.js";
import { functionOf, readCallFacts } from "./callFacts.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { Relation } from "@suss/ir-core";
import type { CallEdge, FunctionKey } from "./callFacts.js";

/** One boundary a unit comes to, and the calls it takes to get there. */
export interface ReachedEffect {
  readonly relation: Relation;
  readonly label: string;
  /** The calls between the boundary's own unit and this one. */
  readonly through: readonly string[];
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
 * How far one walk goes before it stops. The visited set already covers
 * cycles; this cap is for a graph wide enough that walking it from every
 * boundary costs more than the answer returns.
 */
const WALK_LIMIT = 5000;

/** A boundary and the unit serving it, which is how the two sides pair. */
function entrypointKey(summary: BehavioralSummary, boundary: string): string {
  return `${boundary} ${summary.location.file}::${summary.identity.name}`;
}

function effectKey(relation: Relation, label: string): string {
  return `${relation} ${label}`;
}

/** The calls out of each function, from the facts a summary set states. */
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
 * of calls to each. A unit's own boundary is left out, since serving a
 * route is not something the route reaches.
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
          const key = effectKey(touch.relation, touch.label);
          if (reached.has(key)) {
            continue;
          }
          reached.set(key, {
            relation: touch.relation,
            label: touch.label,
            through,
          });
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

/** What every boundary in one summary set reaches. */
function entrypointsOf(
  summaries: readonly BehavioralSummary[],
): Map<string, Entrypoint> {
  const facts = readCallFacts(summaries);
  const out = adjacency(facts.edges());
  const entrypoints = new Map<string, Entrypoint>();

  for (const summary of summaries) {
    const binding = summary.identity.boundaryBinding;
    if (
      binding === null ||
      BOUNDARY_ROLE[summary.kind] !== "provider" ||
      !leavesTheProcess(binding)
    ) {
      continue;
    }
    const boundary = boundarySpelling(binding);
    const key = entrypointKey(summary, boundary);
    if (entrypoints.has(key)) {
      continue;
    }
    entrypoints.set(key, {
      boundary,
      unit: summary.identity.name,
      file: summary.location.file,
      reached: reachedFrom(functionOf(summary), boundary, out, facts.units),
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
    key: `${side.file}::${side.unit}`,
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
