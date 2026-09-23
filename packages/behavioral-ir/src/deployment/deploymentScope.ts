/**
 * The work both channels do before either can say anything: place every
 * runtime against the code it runs, and group the units by file.
 *
 * Both `deployedValues` and `deployedRefs` need it, and a caller that
 * wants both, which is anything asking a `Deployment`, would otherwise
 * walk the module graph twice for one result.
 */

import { buildModuleGraph } from "./entryClosure.js";
import { placeRuntimes } from "./placement.js";
import { unitsByFile } from "./unitScope.js";

import type { BehavioralSummary } from "../index.js";
import type { ModuleGraph } from "./entryClosure.js";
import type { PlacedRuntime } from "./placement.js";
import type { UnitsByFile } from "./unitScope.js";

export interface DeploymentScope {
  placed: PlacedRuntime[];
  byFile: UnitsByFile;
  /** Kept so a caller placing other declared summaries reuses it. */
  graph: ModuleGraph;
}

export function deploymentScope(
  summaries: BehavioralSummary[],
): DeploymentScope {
  const graph = buildModuleGraph(summaries);
  return {
    placed: placeRuntimes(summaries, graph).placed,
    byFile: unitsByFile(summaries),
    graph,
  };
}
