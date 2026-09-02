/**
 * The work both channels do before either can say anything: place every
 * runtime against the code it runs, and group the units by file.
 *
 * Both `deployedValues` and `deployedRefs` need it, and a caller that
 * wants both, which is anything asking a `Deployment`, would otherwise
 * walk the module graph twice for one result.
 */

import { placeRuntimes } from "./placement.js";
import { unitsByFile } from "./unitScope.js";

import type { BehavioralSummary } from "../index.js";
import type { PlacedRuntime } from "./placement.js";
import type { UnitsByFile } from "./unitScope.js";

export interface DeploymentScope {
  placed: PlacedRuntime[];
  byFile: UnitsByFile;
}

export function deploymentScope(
  summaries: BehavioralSummary[],
): DeploymentScope {
  return {
    placed: placeRuntimes(summaries).placed,
    byFile: unitsByFile(summaries),
  };
}
