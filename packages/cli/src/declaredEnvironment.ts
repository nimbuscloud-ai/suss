/**
 * What changed in the environment a deployment template declares for
 * each deployable: the variables it sets, and the parameter or resource
 * a variable's value comes from.
 *
 * The template's runtime summary has no transitions, so the summary
 * diff never sees these. A reviewer needs them anyway, since a variable
 * added to a template is a change to what the deployed code is given.
 * The diff lists each one in the deployable's block, beside the reads
 * of it by the code that runs there.
 */

import { declaredEnvVars, isRuntimeConfigProvider } from "@suss/behavioral-ir";
import { displayLabel } from "@suss/ir-core";

import { entrypointKey } from "./diffReach.js";

import type { BehavioralSummary, BoundaryBinding } from "@suss/behavioral-ir";

/** One variable a template started or stopped declaring for a deployable. */
export interface Declaration {
  readonly change: "added" | "removed";
  readonly name: string;
  /** The parameter or resource the value comes from, when the template wires it to one. */
  readonly from?: string;
}

/** A deployable whose declared environment changed. */
export interface DeclarationChange {
  /** The key the diff gives this deployable's block. */
  readonly key: string;
  readonly boundary: string;
  readonly binding: BoundaryBinding;
  readonly unit: string;
  readonly file: string;
  readonly change: "added" | "removed" | "changed";
  readonly declarations: readonly Declaration[];
}

/** Every deployable whose template declares different variables than before. */
export function declarationChanges(
  before: readonly BehavioralSummary[],
  after: readonly BehavioralSummary[],
): DeclarationChange[] {
  const earlier = runtimesByKey(before);
  const later = runtimesByKey(after);
  const changes: DeclarationChange[] = [];

  for (const key of new Set([...earlier.keys(), ...later.keys()])) {
    const was = earlier.get(key);
    const now = later.get(key);
    const side = (now ?? was) as Runtime;
    const declarations = [
      ...onlyIn(now, was, "added"),
      ...onlyIn(was, now, "removed"),
    ];
    if (declarations.length === 0) {
      continue;
    }
    changes.push({
      key,
      boundary: side.boundary,
      binding: side.binding,
      unit: side.summary.identity.name,
      file: side.summary.location.file,
      change: whichWay(was, now),
      declarations,
    });
  }
  return changes.sort((a, b) => a.key.localeCompare(b.key));
}

interface Runtime {
  summary: BehavioralSummary;
  binding: BoundaryBinding;
  boundary: string;
  declared: ReadonlyMap<string, string | undefined>;
}

function runtimesByKey(
  summaries: readonly BehavioralSummary[],
): Map<string, Runtime> {
  const runtimes = new Map<string, Runtime>();
  for (const summary of summaries) {
    const binding = summary.identity.boundaryBinding;
    if (binding === null || !isRuntimeConfigProvider(summary)) {
      continue;
    }
    const boundary = displayLabel(binding);
    runtimes.set(
      entrypointKey(summary.location.file, summary.identity.name, boundary),
      { summary, binding, boundary, declared: declaredEnvVars(summary) },
    );
  }
  return runtimes;
}

function onlyIn(
  from: Runtime | undefined,
  against: Runtime | undefined,
  change: Declaration["change"],
): Declaration[] {
  if (from === undefined) {
    return [];
  }
  return [...from.declared]
    .filter(([name]) => against?.declared.has(name) !== true)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, source]) => ({
      change,
      name,
      ...(source === undefined ? {} : { from: source }),
    }));
}

function whichWay(
  was: Runtime | undefined,
  now: Runtime | undefined,
): DeclarationChange["change"] {
  if (was === undefined) {
    return "added";
  }
  return now === undefined ? "removed" : "changed";
}
