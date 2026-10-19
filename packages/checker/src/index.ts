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
import { isContractDocument } from "./contract/declaredContract.js";
import { checkGraphqlContractAgreement } from "./contract/graphqlContractAgreement.js";
import { checkProviderCoverage } from "./coverage/providerCoverage.js";
import { checkResponseMisread } from "./coverage/responseMisread.js";
import { dedupeFindings, findingPerConsumerPath } from "./dedupe.js";
import { buildInteractionIndex } from "./interactions/dispatcher.js";
import { checkMessageBus } from "./message-bus/messageBusPairing.js";
import { checkMetric } from "./metric/metricPairing.js";
import { pairGraphqlOperations } from "./pairing/graphqlPairing.js";
import { pairSummaries, servingFunction } from "./pairing/pairing.js";
import { checkSemanticBridging } from "./pairing/semanticBridging.js";
import { isStory, isTestCode } from "./pairing/testCode.js";
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
export {
  type CallEdge,
  type CallFacts,
  type CallHop,
  type CallPath,
  type CallRecord,
  callSpellings,
  type DirectCall,
  type FunctionKey,
  functionOf,
  type Reached,
  type ReachTarget,
  readCallFacts,
} from "./calls/callFacts.js";
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
export { dedupeFindings, mergedSideOf } from "./dedupe.js";
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
  type BoundaryCollision,
  boundaryCollisions,
  type SummaryClaim,
} from "./pairing/boundaryCollisions.js";
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
export {
  checkRuntimeConfig,
  type EnvVarRead,
  type RuntimeReads,
  runtimeReads,
} from "./runtime-config/runtimeConfigPairing.js";
export {
  type ChangedBoundary,
  type ChangesSince,
  type CheckedRun,
  changedBoundaries,
  changesSince,
  type FindingsSince,
  findingsSince,
} from "./since/changesSince.js";
export {
  boundaryKeyOf,
  findingIdentity,
  normalizedDescription,
} from "./since/findingIdentity.js";

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

/**
 * Compare one provider with one consumer. Named types are put back into
 * the shapes first, because comparing two refs only compares their names.
 */
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
  return findingPerConsumerPath([
    ...checkProviderCoverage(provider, consumer),
    ...checkResponseMisread(provider, consumer),
    ...checkConsumerSatisfaction(provider, consumer),
    ...checkContractConsistency(provider, consumer),
    ...checkConsumerContract(provider, consumer),
    ...checkBodyCompatibility(provider, consumer),
    ...checkSemanticBridging(provider, consumer),
  ]);
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
  return {
    kind: "ambiguousProvider",
    boundary: binding,
    provider: { summary: summaryRef(first), location: first.location },
    consumer: { summary: summaryRef(consumer), location: consumer.location },
    description:
      services.length > 1
        ? servicesTieDescription(consumer, binding, services)
        : routesTieDescription(consumer, binding, providers),
    severity: "warning",
  };
}

function servicesTieDescription(
  consumer: BehavioralSummary,
  binding: BoundaryBinding,
  services: readonly string[],
): string {
  const named = services.map((service) =>
    service === "" ? "(unnamed)" : service,
  );
  return `${summaryIdentifier(consumer)} calls ${describeBinding(binding)}, and ${services.length} services serve it (${named.join(", ")}). Nothing here says which one it reaches, so no pair was checked. Give the client the base URL it calls, or check one service at a time.`;
}

/** Two routes in one service match the call, such as two catch-alls, and neither is more specific. */
function routesTieDescription(
  consumer: BehavioralSummary,
  binding: BoundaryBinding,
  providers: readonly BehavioralSummary[],
): string {
  const handlers = new Set(providers.map(servingFunction)).size;
  const routes = [
    ...new Set(
      providers.map((provider) =>
        describeBinding(provider.identity.boundaryBinding as BoundaryBinding),
      ),
    ),
  ];
  return `${summaryIdentifier(consumer)} calls ${describeBinding(binding)}, and ${handlers} handlers serve it at routes that match it equally well (${routes.join(", ")}). The framework picks one by the order the routes are declared, which suss does not read, so no pair was checked.`;
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
  // REST pairing lists test code as unpairable, and every other pass
  // leaves it out the same way.
  const production = summaries.filter((summary) => !isTestCode(summary));
  const graphql = pairGraphqlOperations(production);

  const findings: Finding[] = [
    ...graphql.findings,
    ...restAmbiguous.map(twoServicesServeIt),
  ];
  const pairInfo: CheckAllResult["pairs"] = [];

  // A pair that no check here compares is still listed, so a reader can
  // see it. The pass for its protocol reports the findings.
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
  findings.push(...checkContractAgreement(production));
  findings.push(...checkContractCompleteness(production));
  findings.push(...checkContractImplementation(production, pairInfo));
  findings.push(...checkGraphqlContractAgreement(production));
  // Stories are left out of pairing, and comparing them with the
  // components they render is this pass's whole job.
  findings.push(
    ...checkComponentStoryAgreement([
      ...production,
      ...summaries.filter(isStory),
    ]),
  );
  findings.push(...checkRenderProps(production));

  // Indexed once and shared: each pass would otherwise walk every
  // transition's effects itself, and the walks add up per pass.
  const interactionIndex = buildInteractionIndex(production);

  findings.push(...checkRuntimeConfig(production, interactionIndex, pairInfo));
  findings.push(...checkStorage(production, interactionIndex, pairInfo));
  findings.push(...checkMessageBus(production, interactionIndex, pairInfo));
  findings.push(...checkUnitInvocation(production, interactionIndex, pairInfo));
  findings.push(...checkMetric(production, interactionIndex));

  // Pairing matches on method and path, so it lists a store or a queue as
  // unpaired even after the pass for that protocol compared it.
  const compared = new Set(pairInfo.flatMap((p) => [p.provider, p.consumer]));
  const wentUncompared = (s: BehavioralSummary): boolean =>
    !compared.has(summaryIdentifier(s));
  // A handler that paired only at the table it writes still has no client.
  const comparedAtKey = new Set(
    pairInfo.flatMap((p) => [
      comparedAt(p.key, p.provider),
      comparedAt(p.key, p.consumer),
    ]),
  );
  const wentUncomparedAtItsBoundary = (s: BehavioralSummary): boolean => {
    const { key } = describeUnmatched(s);
    if (key === null) {
      return wentUncompared(s);
    }

    return !comparedAtKey.has(comparedAt(key, summaryIdentifier(s)));
  };

  return {
    findings: dedupeFindings(
      findings,
      new Set(production.filter(isContractDocument).map(summaryRef)),
    ),
    pairs: pairInfo,
    unmatched: {
      providers: unmatched.providers
        .filter(wentUncomparedAtItsBoundary)
        .map(describeUnmatched),
      consumers: unmatched.consumers
        .filter(wentUncomparedAtItsBoundary)
        .map(describeUnmatched),
      unpairable: unmatched.unpairable
        .filter((u) => wentUncompared(u.summary))
        .map((u) => ({ ...describeUnmatched(u.summary), reason: u.reason })),
    },
  };
}

function comparedAt(key: string, summary: string): string {
  return `${key}\0${summary}`;
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
