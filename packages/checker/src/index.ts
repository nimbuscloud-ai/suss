import { checkConsumerSatisfaction } from "./consumer-satisfaction.js";
import { checkContractConsistency } from "./contract-consistency.js";
import { checkProviderCoverage } from "./provider-coverage.js";

import type { BehavioralSummary, Finding } from "@suss/behavioral-ir";

export { checkConsumerSatisfaction } from "./consumer-satisfaction.js";
export { checkContractConsistency } from "./contract-consistency.js";
export { type MatchResult, predicatesMatch, subjectsMatch } from "./match.js";
export { checkProviderCoverage } from "./provider-coverage.js";

export function checkPair(
  provider: BehavioralSummary,
  consumer: BehavioralSummary,
): Finding[] {
  return [
    ...checkProviderCoverage(provider, consumer),
    ...checkConsumerSatisfaction(provider, consumer),
    ...checkContractConsistency(provider, consumer),
  ];
}
