/**
 * What suss says each route reaches, asked the way a user asks it.
 *
 * Routes are joined on suss's own route identity: a method that agrees
 * and a path with the same shape after `normalizePath`, so `:id`,
 * `{id}` and `{item_id}` are one segment. A route that only overlaps a
 * suss route, such as one behind a mount suss wrote as a hole, falls
 * back to `routePathsMeet`. For each joined route the oracle asks
 * `what does <route> reach` through `answerQuestion`, the function the
 * `suss ask` command runs, so the answer is the one a user would get.
 */

import os from "node:os";

import { BOUNDARY_ROLE, displayLabel } from "@suss/behavioral-ir";
import {
  answerQuestion,
  functionOf,
  loadedSummaries,
  readSummariesFromDir,
} from "@suss/cli";
import { methodsAgree, pathShape, routePathsMeet } from "@suss/ir-core";

import type { BehavioralSummary, BoundaryBinding } from "@suss/behavioral-ir";
import type { LoadedSummaries } from "@suss/cli";
import type { RouteEntry } from "./edges.js";

export interface SussRoute {
  label: string;
  method: string | null;
  path: string;
  summaries: BehavioralSummary[];
}

export interface RouteMatch {
  routes: SussRoute[];
  how: "sameShape" | "overlap" | null;
}

/** One boundary in the answer to `what does <route> reach`. */
export interface Reach {
  label: string;
  bindings: BoundaryBinding[];
  through: string[];
  possible: boolean;
}

/** What the walk from a route met: the units, and the calls it could not follow or could not settle. */
export interface Walk {
  units: BehavioralSummary[];
  unfollowed: Array<{ unit: string; callee: string; description: string }>;
  dispatched: Array<{ unit: string; callee: string }>;
}

function restBinding(summary: BehavioralSummary): BoundaryBinding | null {
  const binding = summary.identity.boundaryBinding;
  if (binding === null || binding.semantics.name !== "rest") {
    return null;
  }
  return BOUNDARY_ROLE[summary.kind] === "provider" ? binding : null;
}

function interactionBindings(summary: BehavioralSummary): BoundaryBinding[] {
  const found: BoundaryBinding[] = [];
  for (const transition of summary.transitions) {
    for (const effect of transition.effects) {
      if (effect.type === "interaction") {
        found.push(effect.binding);
      }
    }
  }
  return found;
}

// A callee called through a subscript, `TABLE[key](...)`, or a reflective send picks its function at run time.
const COMPUTED_CALLEE =
  /\]\s*\(|(^|[.\s])(getattr|public_send|send|__send__)(\(|$)/;

// The two stops whose sentence says the call had more than one candidate.
const SEVERAL_CANDIDATES =
  /more than one possible source|reads as .* different values/;

export class SussSide {
  readonly summaries: BehavioralSummary[];
  readonly routes: SussRoute[];
  private readonly loaded: LoadedSummaries;
  /** Every boundary an interaction crosses, by the label `ask` prints for it. */
  private readonly bindingsByLabel = new Map<string, BoundaryBinding[]>();
  /** Every unit with an interaction, and the bindings it crosses. */
  readonly touching: Array<{
    unit: BehavioralSummary;
    bindings: BoundaryBinding[];
  }> = [];
  private readonly reaches = new Map<string, Reach[]>();

  constructor(summariesDir: string) {
    this.summaries = readSummariesFromDir(summariesDir);
    this.loaded = loadedSummaries(this.summaries);
    const routes = new Map<string, SussRoute>();
    for (const summary of this.summaries) {
      const own = restBinding(summary);
      const semantics = own?.semantics as
        | { method: string | null; path: string | null }
        | undefined;
      if (own !== null && semantics?.path !== null && semantics !== undefined) {
        const label = displayLabel(own);
        const known = routes.get(label);
        if (known === undefined) {
          routes.set(label, {
            label,
            method: semantics.method,
            path: semantics.path as string,
            summaries: [summary],
          });
        } else {
          known.summaries.push(summary);
        }
      }
      const bindings = interactionBindings(summary);
      if (bindings.length > 0) {
        this.touching.push({ unit: summary, bindings });
      }
      for (const binding of bindings) {
        const label = displayLabel(binding);
        this.bindingsByLabel.set(label, [
          ...(this.bindingsByLabel.get(label) ?? []),
          binding,
        ]);
      }
    }
    this.routes = [...routes.values()];
  }

  /** Every binding any interaction in the run crosses. */
  allInteractionBindings(): BoundaryBinding[] {
    return [...this.bindingsByLabel.values()].flat();
  }

  matchRoute(entry: RouteEntry): RouteMatch {
    const agreeing = this.routes.filter((route) =>
      methodsAgree(route.method, entry.method),
    );
    const shape = pathShape(entry.route);
    const same = agreeing.filter((route) => pathShape(route.path) === shape);
    if (same.length > 0) {
      return { routes: same, how: "sameShape" };
    }
    const overlap = agreeing.filter((route) =>
      routePathsMeet(route.path, entry.route),
    );
    return overlap.length > 0
      ? { routes: overlap, how: "overlap" }
      : { routes: [], how: null };
  }

  /** The answer to `what does <route> reach`, asked by the route's label, or by each summary id when the label does not resolve. */
  reachOf(route: SussRoute): Reach[] {
    const cached = this.reaches.get(route.label);
    if (cached !== undefined) {
      return cached;
    }
    const items =
      this.ask(route.label) ??
      route.summaries.flatMap(
        (summary) =>
          this.ask(summary.identity.id ?? summary.identity.name) ?? [],
      );
    const reaches = items.map((item) => ({
      label: item.boundary,
      bindings: this.bindingsByLabel.get(item.boundary) ?? [],
      through: item.through ?? [],
      possible: item.possible === true,
    }));
    this.reaches.set(route.label, reaches);
    return reaches;
  }

  private ask(subject: string): ReachItem[] | null {
    const { answer } = answerQuestion({
      question: `what does ${subject} reach`,
      loaded: this.loaded,
      json: true,
      output: os.devNull,
    });
    if (answer === null || !answer.found) {
      return null;
    }
    return answer.items as ReachItem[];
  }

  /** The units the routes' calls lead to, with the calls on the way that suss could not follow. */
  walkOf(routes: readonly SussRoute[]): Walk {
    const start = routes.flatMap((route) => route.summaries);
    const facts = this.loaded.callFacts;
    const reached = facts.reachedFrom(start.map((unit) => functionOf(unit)));
    const units = [
      ...start,
      ...[...reached.keys()].flatMap((fn) => facts.units.get(fn) ?? []),
    ];
    const walk: Walk = { units, unfollowed: [], dispatched: [] };
    for (const unit of units) {
      const name = unit.identity.name;
      for (const gap of unit.gaps) {
        if (gap.type !== "unfollowedCall" || gap.callee === undefined) {
          continue;
        }
        if (SEVERAL_CANDIDATES.test(gap.description)) {
          walk.dispatched.push({ unit: name, callee: gap.callee });
          continue;
        }
        walk.unfollowed.push({
          unit: name,
          callee: gap.callee,
          description: gap.description,
        });
      }
      for (const transition of unit.transitions) {
        for (const effect of transition.effects) {
          if (effect.type !== "invocation") {
            continue;
          }
          if (
            effect.possibleSummaries !== undefined ||
            (effect.summary === undefined &&
              COMPUTED_CALLEE.test(effect.callee))
          ) {
            walk.dispatched.push({ unit: name, callee: effect.callee });
          }
        }
      }
    }
    return walk;
  }
}

interface ReachItem {
  boundary: string;
  through?: string[];
  possible?: boolean;
}
