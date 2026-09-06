import { summaryIdentifier, summaryRef } from "@suss/behavioral-ir";
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
import { checkContractImplementation } from "./contract/contractImplementation.js";
import { checkGraphqlContractAgreement } from "./contract/graphqlContractAgreement.js";
import { checkProviderCoverage } from "./coverage/providerCoverage.js";
import { checkResponseMisread } from "./coverage/responseMisread.js";
import { dedupeFindings } from "./dedupe.js";
import { buildInteractionIndex } from "./interactions/dispatcher.js";
import { checkMessageBus } from "./message-bus/messageBusPairing.js";
import { checkMetric } from "./metric/metricPairing.js";
import { pairGraphqlOperations } from "./pairing/graphqlPairing.js";
import { pairSummaries } from "./pairing/pairing.js";
import { checkSemanticBridging } from "./pairing/semanticBridging.js";
import { checkRenderProps } from "./render/renderProps.js";
import { checkRuntimeConfig } from "./runtime-config/runtimeConfigPairing.js";
import { checkStorage } from "./storage/storagePairing.js";
import { checkComponentStoryAgreement } from "./story/componentStoryAgreement.js";
import { checkUnitInvocation } from "./unit-invocation/unitInvocationPairing.js";

import type {
  BehavioralSummary,
  BoundaryBinding,
  Finding,
} from "@suss/behavioral-ir";
import type { ComparedPair } from "./pairing/comparedPair.js";
import type {
  AmbiguousPairing,
  SummaryPair,
  UnpairableReason,
} from "./pairing/pairing.js";

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
export { checkContractImplementation } from "./contract/contractImplementation.js";
export {
  contractDeclaresStatus,
  type DeclaredContract,
  readDeclaredContract,
} from "./contract/declaredContract.js";
export {
  type GraphqlContractProvenance,
  type GraphqlDeclaredContract,
  readGraphqlDeclaredContract,
} from "./contract/graphqlContract.js";
export { checkGraphqlContractAgreement } from "./contract/graphqlContractAgreement.js";
export { checkProviderCoverage } from "./coverage/providerCoverage.js";
export { checkResponseMisread } from "./coverage/responseMisread.js";
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
export { checkMetric } from "./metric/metricPairing.js";
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
export { checkRenderProps } from "./render/renderProps.js";
export { checkRuntimeConfig } from "./runtime-config/runtimeConfigPairing.js";

export type { ComparedPair } from "./pairing/comparedPair.js";

import { summaryWithDefinitionsInlined } from "./spelledOut.js";

export { summaryWithDefinitionsInlined } from "./spelledOut.js";
export {
  checkStorage,
  type GroundedBy,
  type GroundedStorage,
  type GroundedStorageAccess,
  type GroundedStorageProvider,
  groundStorageAccesses,
  storageBoundaryKey,
} from "./storage/storagePairing.js";
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
export {
  checkUnitInvocation,
  type InvokesInRun,
  invokersOfUnits,
} from "./unit-invocation/unitInvocationPairing.js";

export type { GroundedName, Grounding } from "./storage/grounding.js";

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
    ...checkResponseMisread(provider, consumer),
    ...checkConsumerSatisfaction(provider, consumer),
    ...checkContractConsistency(provider, consumer),
    ...checkConsumerContract(provider, consumer),
    ...checkBodyCompatibility(provider, consumer),
    ...checkSemanticBridging(provider, consumer),
  ];
}

export interface CheckAllResult {
  findings: Finding[];
  pairs: ComparedPair[];
  unmatched: {
    providers: Array<{ id: string; name: string; key: string | null }>;
    consumers: Array<{ id: string; name: string; key: string | null }>;
    /** Summaries that took no part in pairing, each saying why. */
    unpairable: Array<{
      id: string;
      name: string;
      key: string | null;
      reason: UnpairableReason;
    }>;
  };
}

/**
 * A consumer whose path several services serve. Pairing it with any one
 * of them compares a caller against a handler it may never reach, so
 * the run says who serves the path and leaves the choice to a reader.
 */
function twoServicesServeIt(ambiguous: AmbiguousPairing): Finding {
  const { consumer, providers, services } = ambiguous;
  const first = providers[0] as BehavioralSummary;
  const binding = consumer.identity.boundaryBinding as BoundaryBinding;
  const named = services.map((service) =>
    service === "" ? "(unnamed)" : service,
  );
  return {
    kind: "ambiguousProvider",
    boundary: binding,
    provider: { summary: summaryRef(first), location: first.location },
    consumer: { summary: summaryRef(consumer), location: consumer.location },
    description: `${summaryIdentifier(consumer)} calls ${describeBinding(binding)}, and ${services.length} services serve it (${named.join(", ")}). Nothing here says which one it reaches, so no pair was checked. Give the client the base URL it calls, or check one service at a time.`,
    severity: "warning",
  };
}

/**
 * Pairs every provider with every consumer and checks each pair. Two
 * providers describing one boundary produce one finding between them,
 * with `sources` set; `checkPair` on its own does no such collapsing.
 */
export function checkAll(summaries: BehavioralSummary[]): CheckAllResult {
  const {
    pairs: restPairs,
    unmatched: restUnmatched,
    ambiguous: restAmbiguous,
  } = pairSummaries(summaries);
  const graphql = pairGraphqlOperations(summaries);

  const findings: Finding[] = [
    ...graphql.findings,
    ...restAmbiguous.map(twoServicesServeIt),
  ];
  const pairInfo: CheckAllResult["pairs"] = [];

  // A pair that no check here judges is still reported, so a reader can
  // see it. The pass that knows its protocol emits the findings.
  for (const pair of restPairs) {
    if (pairIsCheckable(pair)) {
      findings.push(...checkPair(pair.provider, pair.consumer));
    }
    pairInfo.push({
      key: pair.key,
      provider: summaryIdentifier(pair.provider),
      consumer: summaryIdentifier(pair.consumer),
    });
  }
  const graphqlMatched = new Set<BehavioralSummary>();
  for (const { provider, consumer, key } of graphql.pairs) {
    graphqlMatched.add(provider);
    graphqlMatched.add(consumer);
    pairInfo.push({
      key,
      provider: summaryIdentifier(provider),
      consumer: summaryIdentifier(consumer),
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
  findings.push(...checkContractImplementation(summaries, pairInfo));
  findings.push(...checkGraphqlContractAgreement(summaries));
  findings.push(...checkComponentStoryAgreement(summaries));
  findings.push(...checkRenderProps(summaries));

  // Indexed once and shared: each pass would otherwise walk every
  // transition's effects itself, and the walks add up per pass.
  const interactionIndex = buildInteractionIndex(summaries);

  findings.push(...checkRuntimeConfig(summaries, interactionIndex, pairInfo));
  findings.push(...checkStorage(summaries, interactionIndex, pairInfo));
  findings.push(...checkMessageBus(summaries, interactionIndex, pairInfo));
  findings.push(...checkUnitInvocation(summaries, interactionIndex, pairInfo));
  findings.push(...checkMetric(summaries, interactionIndex));

  // Pairing only knows method and path, so it files a store or a queue
  // as unpaired even after the pass that owns that protocol compared it.
  const compared = new Set(pairInfo.flatMap((p) => [p.provider, p.consumer]));
  const wentUncompared = (s: BehavioralSummary): boolean =>
    !compared.has(summaryIdentifier(s));

  return {
    findings: dedupeFindings(findings),
    pairs: pairInfo,
    unmatched: {
      providers: unmatched.providers
        .filter(wentUncompared)
        .map(describeUnmatched),
      consumers: unmatched.consumers
        .filter(wentUncompared)
        .map(describeUnmatched),
      unpairable: unmatched.unpairable
        .filter((u) => wentUncompared(u.summary))
        .map((u) => ({ ...describeUnmatched(u.summary), reason: u.reason })),
    },
  };
}

function describeUnmatched(summary: BehavioralSummary): {
  id: string;
  name: string;
  key: string | null;
} {
  const binding = summary.identity.boundaryBinding;
  return {
    id: summaryIdentifier(summary),
    name: summary.identity.name,
    key: binding !== null ? describeBinding(binding) : null,
  };
}
