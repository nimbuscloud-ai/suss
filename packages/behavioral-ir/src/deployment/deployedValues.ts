/**
 * What the deployment sets a variable to, for the code that runs in it.
 *
 * A name filled in at deploy time is written one way in the source and
 * another way in the template that deploys it. `{SUBSCRIBER_TABLE}` in
 * the code and `prod-subscribers-v1` in the template are one table, and
 * pairing the two means looking the variable up in the runtime.
 *
 * The answer depends on scope. Two services in one repository can both
 * set `API_BASE` to different hosts, so a lookup checks which runtime
 * the code in question runs in and does not take the first match.
 */

import { readRuntimeContractMetadata } from "../metadata.js";
import { type DeploymentScope, deploymentScope } from "./deploymentScope.js";
import { runsIn } from "./unitScope.js";

import type { BehavioralSummary } from "../index.js";

/** A value the deployment sets, and the runtime that sets it. */
export interface DeployedValue {
  value: string;
  source: BehavioralSummary;
}

/**
 * A lookup of the values a variable is set to, for a given unit.
 *
 * The lookup returns an empty list when no runtime in the run sets the
 * variable, or when the runtimes that do are not the ones this unit
 * runs in.
 */
export function deployedValues(
  summaries: BehavioralSummary[],
  scope?: DeploymentScope,
): (summary: BehavioralSummary, variable: string) => DeployedValue[] {
  const { placed, byFile } = scope ?? deploymentScope(summaries);
  if (placed.length === 0) {
    return () => [];
  }
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
