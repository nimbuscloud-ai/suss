/**
 * Which code each declared runtime runs.
 *
 * A runtime-config provider says what a deployable is given and where
 * its code is. Working out which summaries that covers is the same
 * question whether you are checking that a variable is supplied or
 * asking what a variable is set to, so both passes ask it here.
 *
 * Two things can say where the code is, and either will do. A handler
 * entry that matches a module gives the import closure, which is the
 * exact answer. A source directory gives a prefix, which is the rough
 * one. A Terraform configuration states only the handler, since the
 * zip it deploys is built somewhere the configuration never says.
 */

import { bindingIs } from "@suss/ir-core";

import { buildModuleGraph, entryClosure } from "./entryClosure.js";
import { readCodeScope } from "./unitScope.js";

import type { BehavioralSummary, BoundaryBinding } from "../index.js";
import type { ModuleGraph } from "./entryClosure.js";
import type { UnitScope } from "./unitScope.js";

/** A runtime and the answer to "which code runs in it". */
export interface PlacedRuntime {
  runtime: BehavioralSummary;
  binding: BoundaryBinding;
  scope: UnitScope;
}

export interface Placement {
  /** The runtimes whose code scope this could work out. */
  placed: PlacedRuntime[];
  /**
   * The runtimes that said nothing about where their code is, paired
   * with the binding a caller needs to report them.
   */
  unplaced: Array<{ runtime: BehavioralSummary; binding: BoundaryBinding }>;
}

export function isRuntimeConfigProvider(summary: BehavioralSummary): boolean {
  return bindingIs(summary.identity.boundaryBinding, "runtime-config");
}

/**
 * Place every runtime-config provider in the set. A caller that places
 * other declared summaries too passes the graph it built, so the
 * summaries are walked once.
 */
export function placeRuntimes(
  summaries: BehavioralSummary[],
  graph: ModuleGraph = buildModuleGraph(summaries),
): Placement {
  const placed: PlacedRuntime[] = [];
  const unplaced: Placement["unplaced"] = [];

  for (const runtime of summaries.filter(isRuntimeConfigProvider)) {
    const binding = runtime.identity.boundaryBinding;
    // The filter above guarantees one. Skip rather than crash.
    /* v8 ignore start */
    if (binding === null) {
      continue;
    }
    /* v8 ignore stop */
    const scope = placeDeclared(runtime, graph);
    if (scope === null) {
      unplaced.push({ runtime, binding });
      continue;
    }

    placed.push({ runtime, binding, scope });
  }

  return { placed, unplaced };
}

/**
 * Which code runs in the unit a declared summary describes, from the
 * code scope it states. An entry that matches a file in the module
 * graph gives that entry's import closure, which decides membership
 * instead of the directory. Null when the summary states neither a
 * matching entry nor a directory.
 */
export function placeDeclared(
  summary: BehavioralSummary,
  graph: ModuleGraph,
): UnitScope | null {
  const codeScope = readCodeScope(summary);
  const closure =
    codeScope.entry !== undefined ? entryClosure(codeScope.entry, graph) : null;
  // Falling back to the directory needs one to have been stated.
  if (closure === null && codeScope.path === undefined) {
    return null;
  }

  return {
    unit: summary.identity.deployableUnit,
    ...(codeScope.path !== undefined ? { codeScope: codeScope.path } : {}),
    ...(closure !== null ? { closure } : {}),
  };
}
