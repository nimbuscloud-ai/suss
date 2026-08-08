import { displayLabel } from "@suss/ir-core";

import { checkBodyCompatibility } from "./body/bodyCompatibility.js";
import { checkConsumerContract } from "./consumer/consumerContract.js";
import { checkConsumerSatisfaction } from "./consumer/consumerSatisfaction.js";
import { checkContractAgreement } from "./contract/contractAgreement.js";
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
import { checkRelationalStorage } from "./storage/relationalPairing.js";
import { checkComponentStoryAgreement } from "./story/componentStoryAgreement.js";

import type {
  BehavioralSummary,
  BoundaryBinding,
  Finding,
} from "@suss/behavioral-ir";
import type { SummaryPair, UnpairableReason } from "./pairing/pairing.js";

/**
 * Human-readable key for unmatched-summary reporting. Each protocol
 * declares its own label; nothing here knows any of them.
 */
function describeBinding(binding: BoundaryBinding): string {
  return displayLabel(binding);
}

/**
 * Whether a pair goes through `checkPair`.
 *
 * Every check behind `checkPair` reads status codes and response
 * shapes off an HTTP exchange, which a queue and the handler draining
 * it never have. Message-bus agreement is checked by `checkMessageBus`
 * over the same summaries, so pairing here is reporting: it says which
 * handler answers a declared subscriber and leaves the findings to the
 * pass that knows how to judge them.
 */
function pairIsCheckable(pair: SummaryPair): boolean {
  return !isMessageBus(pair.provider);
}

function isMessageBus(summary: BehavioralSummary): boolean {
  return summary.identity.boundaryBinding?.semantics.name === "message-bus";
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
export { checkRelationalStorage } from "./storage/relationalPairing.js";
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

/**
 * Compare one boundary's two sides.
 *
 * Each side is read with the types it names put back into its shapes
 * first. A summary writes a named type once and refers to it after
 * that, and a comparison of two refs can only say "same name", so the
 * table goes back in and every check below reads structure the way it
 * always did.
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
    /**
     * Summaries that took no part in pairing, each saying why: internal
     * code with no boundary, a boundary whose name the source never
     * stated, or a kind this build does not know. Renderers group by
     * the reason, so a reader tells "nothing to check" from "something
     * to check, no name to check it by".
     */
    unpairable: Array<{ name: string; reason: UnpairableReason }>;
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
  const { pairs: restPairs, unmatched: restUnmatched } =
    pairSummaries(summaries);
  const graphql = pairGraphqlOperations(summaries);

  const findings: Finding[] = [...graphql.findings];
  const pairInfo: CheckAllResult["pairs"] = [];

  // REST pairs run through the full check-pair machinery
  // (provider coverage, consumer satisfaction, body / contract
  // checks). GraphQL and message-bus pairs surface in `pairInfo` for
  // discoverability but skip checkPair, because the REST checks all key
  // on status-code + response shape, which doesn't apply to resolvers or
  // to queues. Per-semantics checks for GraphQL land alongside
  // `pairGraphqlOperations` when a concrete case motivates them;
  // message-bus already has `checkMessageBus`.
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
  // Track which summaries got at least one graphql pairing so they
  // don't double-surface as unmatched below. Message-bus summaries are
  // dropped from the unmatched lists for a stronger reason: a channel
  // that paired with nothing is already reported by `checkMessageBus`,
  // as `messageBusUnused` or one of the orphan findings, with a
  // severity and with knowledge of who sends to it. Listing it again as
  // "no client to compare against" says the same thing a second time,
  // in weaker words. Pairing owns the pair list; `checkMessageBus` owns
  // every judgement about a channel.
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
    !graphqlMatched.has(s) && !isMessageBus(s);
  const unmatched = {
    providers: restUnmatched.providers.filter(stillUnmatched),
    consumers: restUnmatched.consumers.filter(stillUnmatched),
    unpairable: restUnmatched.unpairable.filter(
      (u) => !graphqlMatched.has(u.summary),
    ),
  };

  // Layer 2: cross-source contract agreement. Runs independently of
  // pairing — it compares each boundary's declared contracts against
  // each other without caring about consumers. Findings emitted here
  // represent disagreement BETWEEN sources, not inconsistency within
  // a single source (which is Layer 1's job).
  findings.push(...checkContractAgreement(summaries));

  // Same shape for GraphQL: when 2+ sources declare a contract for
  // the same gql:Type.field boundary, compare return types + argument
  // shapes. Reuses `contractDisagreement` finding kind.
  findings.push(...checkGraphqlContractAgreement(summaries));

  // Cross-shape agreement for React: pair Storybook stub summaries
  // with inferred component summaries by component name and emit
  // findings for scenario-arg-vs-component-input mismatches. Sits
  // alongside contract agreement because it's the same "multiple
  // declared views of the same boundary" shape, just with a
  // different payload (args vs declaredContract).
  findings.push(...checkComponentStoryAgreement(summaries));

  // Build the interaction index ONCE and share it across all
  // per-class pairing passes (storage, message-bus, runtime-config).
  // Each pass would otherwise walk every transition.effects on its
  // own — fine on small projects, but the per-pass walks scale
  // linearly with the number of pairing passes. Shared indexing
  // walks once, indexes by (class, binding semantics), and hands
  // each pass its slice via O(1) Map lookup.
  const interactionIndex = buildInteractionIndex(summaries);

  // Runtime-config pairing: pair runtime providers (CFN/SAM Lambda
  // env-var declarations) against config-read interaction effects (or
  // legacy invocation-arg `process.env.X` patterns when the
  // node runtime pack's env-var recognizer wasn't in the framework
  // list).
  findings.push(...checkRuntimeConfig(summaries, interactionIndex));

  // Relational-storage pairing: pair schema-derived providers
  // (Prisma model declarations, Drizzle pgTable() declarations)
  // against `interaction(class: "storage-access")` effects on code
  // summaries. Emits the four field-existence findings (read/write
  // unknown, unused, write-only).
  findings.push(...checkRelationalStorage(summaries, interactionIndex));

  // Message-bus pairing: producer interaction effects (from
  // recognizers like @suss/framework-aws-sqs) pair against queue
  // provider summaries (from CFN). Emits orphan-producer/orphan-
  // consumer/unused-queue findings.
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
