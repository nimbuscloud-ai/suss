import {
  displayLabel,
  exchangesHttpResponses,
  reportsUnpairedItself,
} from "@suss/ir-core";

import { checkBodyCompatibility } from "./body/bodyCompatibility.js";
import { checkConsumerContract } from "./consumer/consumerContract.js";
import { checkConsumerSatisfaction } from "./consumer/consumerSatisfaction.js";
import { checkContractAgreement } from "./contract/contractAgreement.js";
import { checkContractCompleteness } from "./contract/contractCompleteness.js";
import { checkContractConsistency } from "./contract/contractConsistency.js";
import { checkGraphqlContractAgreement } from "./contract/graphqlContractAgreement.js";
import { checkProviderCoverage } from "./coverage/providerCoverage.js";
import { dedupeFindings } from "./dedupe.js";
import { buildInteractionIndex } from "./interactions/dispatcher.js";
import { checkMessageBus } from "./message-bus/messageBusPairing.js";
import { pairGraphqlOperations } from "./pairing/graphqlPairing.js";
import { pairSummaries } from "./pairing/pairing.js";
import { checkSemanticBridging } from "./pairing/semanticBridging.js";
import { checkRuntimeConfig } from "./runtime-config/runtimeConfigPairing.js";
import { checkStorage } from "./storage/storagePairing.js";
import { checkComponentStoryAgreement } from "./story/componentStoryAgreement.js";

import type {
  BehavioralSummary,
  BoundaryBinding,
  Finding,
} from "@suss/behavioral-ir";
import type { SummaryPair, UnpairableReason } from "./pairing/pairing.js";

function describeBinding(binding: BoundaryBinding): string {
  return displayLabel(binding);
}

/** Every check behind `checkPair` reads an HTTP status or response shape. */
function pairIsCheckable(pair: SummaryPair): boolean {
  const binding = pair.provider.identity.boundaryBinding;
  if (binding === null || binding === undefined) {
    return true;
  }
  return exchangesHttpResponses(binding);
}

function reportedByItsOwnPass(summary: BehavioralSummary): boolean {
  const binding = summary.identity.boundaryBinding;
  if (binding === null || binding === undefined) {
    return false;
  }
  return reportsUnpairedItself(binding);
}

export { checkBodyCompatibility } from "./body/bodyCompatibility.js";
export { bodyShapesMatch } from "./body/bodyMatch.js";
export { checkConsumerContract } from "./consumer/consumerContract.js";
export { checkConsumerSatisfaction } from "./consumer/consumerSatisfaction.js";
export { checkContractAgreement } from "./contract/contractAgreement.js";
export { checkContractConsistency } from "./contract/contractConsistency.js";
export {
  type GraphqlContractProvenance,
  type GraphqlDeclaredContract,
  readGraphqlDeclaredContract,
} from "./contract/graphqlContract.js";
export { checkGraphqlContractAgreement } from "./contract/graphqlContractAgreement.js";
export { checkProviderCoverage } from "./coverage/providerCoverage.js";
export { dedupeFindings } from "./dedupe.js";
export {
  buildFlowChains,
  type FlowCertainty,
  type FlowChain,
  type FlowChainContext,
  type FlowChains,
  type FlowChainsOmitted,
  type FlowEdgeKind,
  type FlowEnd,
  type FlowHop,
  type FlowHopMatch,
  type FlowServingClaim,
} from "./flow/flowChains.js";
export {
  analyzeFlow,
  FLOW_RULES,
  type FlowAnalysis,
  type FlowEndpointSets,
  type FlowEntry,
  type FlowView,
} from "./flow/reachability.js";
export {
  type AnsweredMatch,
  collectFlowInputs,
  type FlowInputs,
  type RouterMatches,
  type RoutingEdgeFacts,
  type ScopedAnswer,
  type ScopedUnit,
  type ServingClaimSite,
  type UnfollowedEdge,
} from "./flow/routingFacts.js";
export { type MatchResult, predicatesMatch, subjectsMatch } from "./match.js";
export { checkMessageBus } from "./message-bus/messageBusPairing.js";
export {
  type GraphqlPairingResult,
  pairGraphqlOperations,
} from "./pairing/graphqlPairing.js";
export {
  boundaryKey,
  normalizePath,
  type PairingResult,
  pairSummaries,
  type SummaryPair,
  type UnpairableReason,
  type UnpairableSummary,
} from "./pairing/pairing.js";
export { checkSemanticBridging } from "./pairing/semanticBridging.js";
export { checkRuntimeConfig } from "./runtime-config/runtimeConfigPairing.js";

import { summaryWithDefinitionsInlined } from "./spelledOut.js";

export { summaryWithDefinitionsInlined } from "./spelledOut.js";
export { checkStorage } from "./storage/storagePairing.js";
export { checkComponentStoryAgreement } from "./story/componentStoryAgreement.js";
export {
  applySuppressions,
  countsForThreshold,
  type SuppressionFile,
  SuppressionFileSchema,
  type SuppressionRule,
  SuppressionRuleSchema,
  validateRule,
} from "./suppressions.js";

/** Named types go back into the shapes first, because comparing two
 * refs only compares their names. */
export function checkPair(
  provider: BehavioralSummary,
  consumer: BehavioralSummary,
): Finding[] {
  const spelledOut = summaryWithDefinitionsInlined(provider);
  const consuming = summaryWithDefinitionsInlined(consumer);
  return checkSpelledOutPair(spelledOut, consuming);
}

function checkSpelledOutPair(
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
    /** Summaries that took no part in pairing, each saying why. */
    unpairable: Array<{ name: string; reason: UnpairableReason }>;
  };
}

/**
 * Pairs every provider with every consumer and checks each pair. Two
 * providers describing one boundary produce one finding between them,
 * with `sources` set; `checkPair` on its own does no such collapsing.
 */
export function checkAll(summaries: BehavioralSummary[]): CheckAllResult {
  const { pairs: restPairs, unmatched: restUnmatched } =
    pairSummaries(summaries);
  const graphql = pairGraphqlOperations(summaries);

  const findings: Finding[] = [...graphql.findings];
  const pairInfo: CheckAllResult["pairs"] = [];

  // A pair that no check here judges is still reported, so a reader can
  // see it. The pass that knows its protocol emits the findings.
  for (const pair of restPairs) {
    if (pairIsCheckable(pair)) {
      findings.push(...checkPair(pair.provider, pair.consumer));
    }
    pairInfo.push({
      key: pair.key,
      provider: pair.provider.identity.name,
      consumer: pair.consumer.identity.name,
    });
  }
  const graphqlMatched = new Set<BehavioralSummary>();
  for (const { provider, consumer, key } of graphql.pairs) {
    graphqlMatched.add(provider);
    graphqlMatched.add(consumer);
    pairInfo.push({
      key,
      provider: provider.identity.name,
      consumer: consumer.identity.name,
    });
  }
  const stillUnmatched = (s: BehavioralSummary): boolean =>
    !graphqlMatched.has(s) && !reportedByItsOwnPass(s);
  const unmatched = {
    providers: restUnmatched.providers.filter(stillUnmatched),
    consumers: restUnmatched.consumers.filter(stillUnmatched),
    unpairable: restUnmatched.unpairable.filter(
      (u) => !graphqlMatched.has(u.summary),
    ),
  };

  // These compare each boundary's declared contracts against each other
  // and never look at consumers, so they run outside pairing.
  findings.push(...checkContractAgreement(summaries));
  findings.push(...checkContractCompleteness(summaries));
  findings.push(...checkGraphqlContractAgreement(summaries));
  findings.push(...checkComponentStoryAgreement(summaries));

  // Indexed once and shared: each pass would otherwise walk every
  // transition's effects itself, and the walks add up per pass.
  const interactionIndex = buildInteractionIndex(summaries);

  findings.push(...checkRuntimeConfig(summaries, interactionIndex));
  findings.push(...checkStorage(summaries, interactionIndex));
  findings.push(...checkMessageBus(summaries, interactionIndex));

  return {
    findings: dedupeFindings(findings),
    pairs: pairInfo,
    unmatched: {
      providers: unmatched.providers.map((s) => ({
        name: s.identity.name,
        key:
          s.identity.boundaryBinding !== null
            ? describeBinding(s.identity.boundaryBinding)
            : null,
      })),
      consumers: unmatched.consumers.map((s) => ({
        name: s.identity.name,
        key:
          s.identity.boundaryBinding !== null
            ? describeBinding(s.identity.boundaryBinding)
            : null,
      })),
      unpairable: unmatched.unpairable.map((u) => ({
        name: u.summary.identity.name,
        reason: u.reason,
      })),
    },
  };
}
