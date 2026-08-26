/**
 * deployedValues.ts: what the deployment sets a variable to, for the
 * code that runs in it.
 *
 * A name filled in at deploy time is written one way in the source and
 * another way in the thing that runs it. `{SUBSCRIBER_TABLE}` in the
 * code and `prod-subscribers-v1` in the template are one table, and
 * pairing the two means asking the runtime.
 *
 * Scope decides the answer. Two services in one repository can both
 * set `API_BASE` to different hosts, so a lookup asks which runtime
 * the code in question runs in rather than taking the first match.
 */

import { readRuntimeContractMetadata } from "@suss/behavioral-ir";

import { runsIn, unitsByFile } from "../scope/unitScope.js";
import { placeRuntimes } from "./placement.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

/** A value the deployment sets, and the runtime that sets it. */
export interface DeployedValue {
  value: string;
  source: BehavioralSummary;
}

/**
 * Ask what a variable is set to, for a given unit.
 *
 * Empty when no runtime in the run sets it, or when the runtimes that
 * do are not the ones this unit runs in.
 */
export function deployedValues(
  summaries: BehavioralSummary[],
): (summary: BehavioralSummary, variable: string) => DeployedValue[] {
  const { placed } = placeRuntimes(summaries);
  if (placed.length === 0) {
    return () => [];
  }
  const byFile = unitsByFile(summaries);
  const runtimes = placed.map((runtime) => ({
    scope: runtime.scope,
    source: runtime.runtime,
    set: readRuntimeContractMetadata(runtime.runtime)?.envVarValues ?? {},
  }));

  return (summary, variable) => {
    const found: DeployedValue[] = [];
    for (const { scope, source, set } of runtimes) {
      const value = set[variable];
      if (value !== undefined && runsIn(summary, scope, byFile)) {
        found.push({ value, source });
      }
    }
    return found;
  };
}
