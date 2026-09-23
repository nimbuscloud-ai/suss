/**
 * Which code each declared runtime runs.
 *
 * A runtime-config provider declares what a deployable is given and
 * where its code is. The check that a variable is supplied and the
 * lookup of what a variable is set to both need the summaries that
 * covers, so both use this module.
 *
 * Either of two things places the code. A handler entry that matches a
 * module gives its import closure, which is exact. A source directory
 * gives a path prefix, which is approximate. A Terraform configuration
 * gives only the handler, because the zip it deploys is built somewhere
 * the configuration never mentions.
 */

import { bindingIs } from "@suss/ir-core";

import { buildModuleGraph, entryClosure } from "./entryClosure.js";
import { readCodeScope } from "./unitScope.js";

import type { BehavioralSummary, BoundaryBinding } from "../index.js";
import type { ModuleGraph } from "./entryClosure.js";
import type { UnitScope } from "./unitScope.js";

/** A runtime and the scope of the code that runs in it. */
export interface PlacedRuntime {
  runtime: BehavioralSummary;
  binding: BoundaryBinding;
  scope: UnitScope;
}

export interface Placement {
  /** The runtimes whose code scope could be worked out. */
  placed: PlacedRuntime[];
  /**
   * The runtimes that do not say where their code is, each with the
   * binding a caller needs to report it.
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
 * code scope it gives. An entry that matches a file in the module graph
 * gives that entry's import closure, and the closure is used in place
 * of the directory. Null when the summary gives neither a matching
 * entry nor a directory.
 */
export function placeDeclared(
  summary: BehavioralSummary,
  graph: ModuleGraph,
): UnitScope | null {
  const codeScope = readCodeScope(summary);
  const directory = codeScope.kind === "codeUri" ? codeScope.path : undefined;
  const closure =
    codeScope.entry !== undefined ? entryClosure(codeScope.entry, graph) : null;
  // Falling back to the directory needs one to have been stated.
  if (closure === null && directory === undefined) {
    return null;
  }

  return {
    unit: summary.identity.deployableUnit,
    ...(directory !== undefined ? { codeScope: directory } : {}),
    ...(closure !== null ? { closure } : {}),
  };
}
