/**
 * deployedRefs.ts: which resource a variable points at, for the code
 * that runs in the deployment that sets it.
 *
 * A queue URL, a topic ARN and a function name all exist only once the
 * stack is deployed, so code reaches them through an env var and the
 * template sets that variable to `!Ref SomeResource`. Both sides mean
 * one resource and neither writes the other's string, so pairing
 * collapses the chain here first.
 *
 * This is the reference half of `deployedValues` next door, which does
 * the same for a plain string. Scope is worked out the same way, by
 * asking which runtime the code in question runs in.
 */

import { readRuntimeContractMetadata } from "../metadata.js";
import { type DeploymentScope, deploymentScope } from "./deploymentScope.js";
import { runsIn } from "./unitScope.js";

import type { BehavioralSummary } from "../index.js";

/**
 * Ask which template resource a variable points at, for a given unit.
 *
 * Null when no runtime in the run sets it, when the runtimes that do
 * are not the ones this unit runs in, or when two of them point the
 * variable at different resources. Picking one of two answers would be
 * a guess, and an unpaired boundary says less than a wrong pair.
 */
export function deployedRefs(
  summaries: BehavioralSummary[],
  scope?: DeploymentScope,
): (summary: BehavioralSummary, variable: string) => string | null {
  const { placed, byFile } = scope ?? deploymentScope(summaries);
  if (placed.length === 0) {
    return () => null;
  }
  const runtimes = placed.map((runtime) => ({
    scope: runtime.scope,
    targets: readRuntimeContractMetadata(runtime.runtime)?.envVarTargets ?? {},
  }));

  return (summary, variable) => {
    const found = new Set<string>();
    for (const { scope, targets } of runtimes) {
      const target = targets[variable];
      if (target !== undefined && runsIn(summary, scope, byFile)) {
        found.add(target.logicalId);
      }
    }
    const [only] = [...found];
    return found.size === 1 && only !== undefined ? only : null;
  };
}
