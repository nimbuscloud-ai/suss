import { checkBodyCompatibility } from "./body-compatibility.js";
import { checkConsumerContract } from "./consumer-contract.js";
import { checkConsumerSatisfaction } from "./consumer-satisfaction.js";
import { checkContractConsistency } from "./contract-consistency.js";
import { dedupeFindings } from "./dedupe.js";
import { pairSummaries } from "./pairing.js";
import { checkProviderCoverage } from "./provider-coverage.js";
import { checkSemanticBridging } from "./semantic-bridging.js";

import type { BehavioralSummary, Finding } from "@suss/behavioral-ir";

export { checkBodyCompatibility } from "./body-compatibility.js";
export { bodyShapesMatch } from "./body-match.js";
export { checkConsumerContract } from "./consumer-contract.js";
export { checkConsumerSatisfaction } from "./consumer-satisfaction.js";
export { checkContractConsistency } from "./contract-consistency.js";
export { dedupeFindings } from "./dedupe.js";
export { type MatchResult, predicatesMatch, subjectsMatch } from "./match.js";
export {
  boundaryKey,
  normalizePath,
  type PairingResult,
  pairSummaries,
  type SummaryPair,
} from "./pairing.js";
export { checkProviderCoverage } from "./provider-coverage.js";
export { checkSemanticBridging } from "./semantic-bridging.js";
export {
  applySuppressions,
  countsForThreshold,
  type SuppressionFile,
  SuppressionFileSchema,
  type SuppressionRule,
  SuppressionRuleSchema,
  validateRule,
} from "./suppressions.js";

export function checkPair(
  provider: BehavioralSummary,
  consumer: BehavioralSummary,
): Finding[] {
  return [
    ...checkProviderCoverage(provider, consumer),
    ...checkConsumerSatisfaction(provider, consumer),
    ...checkContractConsistency(provider, consumer),
    ...checkConsumerContract(provider, consumer),
    ...checkBodyCompatibility(provider, consumer),
    ...checkSemanticBridging(provider, consumer),
  ];
}

export interface CheckAllResult {
  findings: Finding[];
  pairs: Array<{ key: string; provider: string; consumer: string }>;
  unmatched: {
    providers: Array<{ name: string; key: string | null }>;
    consumers: Array<{ name: string; key: string | null }>;
    noBinding: string[];
  };
}

/**
 * Given a flat list of summaries, automatically pair providers with consumers
 * by `(method, normalizedPath)` and run `checkPair` on each matched pair.
 *
 * Identical findings from overlapping providers (e.g. an OpenAPI stub and
 * a CloudFormation stub describing the same REST endpoint, both producing
 * the same "consumer doesn't handle 400" finding) are collapsed into one
 * representative carrying `sources` that lists every contributor. This
 * noise reduction is *only* at the N×M pair level — `checkPair` on a
 * single pair is unchanged.
 */
export function checkAll(summaries: BehavioralSummary[]): CheckAllResult {
  const { pairs, unmatched } = pairSummaries(summaries);

  const findings: Finding[] = [];
  const pairInfo: CheckAllResult["pairs"] = [];

  for (const { provider, consumer, key } of pairs) {
    findings.push(...checkPair(provider, consumer));
    pairInfo.push({
      key,
      provider: provider.identity.name,
      consumer: consumer.identity.name,
    });
  }

  return {
    findings: dedupeFindings(findings),
    pairs: pairInfo,
    unmatched: {
      providers: unmatched.providers.map((s) => ({
        name: s.identity.name,
        key:
          s.identity.boundaryBinding !== null
            ? `${(s.identity.boundaryBinding.method ?? "ANY").toUpperCase()} ${s.identity.boundaryBinding.path ?? "?"}`
            : null,
      })),
      consumers: unmatched.consumers.map((s) => ({
        name: s.identity.name,
        key:
          s.identity.boundaryBinding !== null
            ? `${(s.identity.boundaryBinding.method ?? "ANY").toUpperCase()} ${s.identity.boundaryBinding.path ?? "?"}`
            : null,
      })),
      noBinding: unmatched.noBinding.map((s) => s.identity.name),
    },
  };
}
