/**
 * Which resource a variable points at, for the code that runs in the
 * deployment that sets it.
 *
 * A queue URL, a topic ARN and a function name exist only once the
 * stack is deployed, so code reaches them through an environment
 * variable and the template sets that variable to `!Ref SomeResource`.
 * Both sides mean one resource and neither writes the other's string,
 * so pairing follows the variable to its resource here first.
 *
 * `deployedValues` does the same for a variable set to a plain string.
 * Both work out scope the same way, by checking which runtime the code
 * in question runs in.
 */

import { readRuntimeContractMetadata } from "../metadata.js";
import { type DeploymentScope, deploymentScope } from "./deploymentScope.js";
import { runsIn } from "./unitScope.js";

import type { BehavioralSummary } from "../index.js";

/**
 * A lookup of the template resource a variable points at, for a given
 * unit.
 *
 * The lookup returns null when no runtime in the run sets the variable,
 * when the runtimes that do are not the ones this unit runs in, or when
 * two of them point it at different resources. Picking one of two would
 * be a guess, and an unpaired boundary misleads less than a wrong pair.
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
