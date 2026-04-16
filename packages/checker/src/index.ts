import { checkBodyCompatibility } from "./body-compatibility.js";
import { checkConsumerSatisfaction } from "./consumer-satisfaction.js";
import { checkContractConsistency } from "./contract-consistency.js";
import { checkProviderCoverage } from "./provider-coverage.js";
import { checkSemanticBridging } from "./semantic-bridging.js";

import type { BehavioralSummary, Finding } from "@suss/behavioral-ir";

export { checkBodyCompatibility } from "./body-compatibility.js";
export { bodyShapesMatch } from "./body-match.js";
export { checkConsumerSatisfaction } from "./consumer-satisfaction.js";
export { checkContractConsistency } from "./contract-consistency.js";
export { type MatchResult, predicatesMatch, subjectsMatch } from "./match.js";
export { checkProviderCoverage } from "./provider-coverage.js";
export { checkSemanticBridging } from "./semantic-bridging.js";

export function checkPair(
  provider: BehavioralSummary,
  consumer: BehavioralSummary,
): Finding[] {
  return [
    ...checkProviderCoverage(provider, consumer),
    ...checkConsumerSatisfaction(provider, consumer),
    ...checkContractConsistency(provider, consumer),
    ...checkBodyCompatibility(provider, consumer),
    ...checkSemanticBridging(provider, consumer),
  ];
}
