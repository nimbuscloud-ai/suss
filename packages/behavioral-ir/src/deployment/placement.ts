/**
 * Which code each declared runtime runs.
 *
 * A runtime-config provider says what a deployable is given and where
 * its code is. Working out which summaries that covers is the same
 * question whether you are checking that a variable is supplied or
 * asking what a variable is set to, so both passes ask it here.
 */

import { bindingIs } from "@suss/ir-core";

import { buildModuleGraph, entryClosure } from "./entryClosure.js";
import { readCodeScope } from "./unitScope.js";

import type { BehavioralSummary, BoundaryBinding } from "../index.js";
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
 * Place every runtime-config provider in the set. A runtime whose entry
 * matches a file in the module graph gets that entry's import closure,
 * which decides membership instead of the directory.
 */
export function placeRuntimes(summaries: BehavioralSummary[]): Placement {
  const graph = buildModuleGraph(summaries);
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
    const codeScope = readCodeScope(runtime);
    if (codeScope.kind === "unknown" || codeScope.path === undefined) {
      unplaced.push({ runtime, binding });
      continue;
    }

    const closure =
      codeScope.entry !== undefined
        ? entryClosure(codeScope.entry, graph)
        : null;
    placed.push({
      runtime,
      binding,
      scope: {
        unit: runtime.identity.deployableUnit,
        codeScope: codeScope.path,
        ...(closure !== null ? { closure } : {}),
      },
    });
  }

  return { placed, unplaced };
}
