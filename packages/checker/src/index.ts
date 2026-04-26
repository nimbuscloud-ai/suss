import { checkBodyCompatibility } from "./body/bodyCompatibility.js";
import { checkConsumerContract } from "./consumer/consumerContract.js";
import { checkConsumerSatisfaction } from "./consumer/consumerSatisfaction.js";
import { checkContractAgreement } from "./contract/contractAgreement.js";
import { checkContractConsistency } from "./contract/contractConsistency.js";
import { checkProviderCoverage } from "./coverage/providerCoverage.js";
import { dedupeFindings } from "./dedupe.js";
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

/**
 * Human-readable pairing key for unmatched-summary reporting. Mirrors
 * `boundaryKey` but falls back to the semantics name when the binding
 * isn't REST-shaped (so a function-call client unable to pair still
 * shows something meaningful in the CLI's unmatched list).
 */
function describeBinding(binding: BoundaryBinding): string {
  const sem = binding.semantics;
  if (sem.name === "rest") {
    const method = sem.method || "ANY";
    const path = sem.path || "?";
    return `${method.toUpperCase()} ${path}`;
  }
  if (sem.name === "graphql-resolver") {
    return `${sem.typeName}.${sem.fieldName}`;
  }
  if (sem.name === "graphql-operation") {
    const label = sem.operationName ?? "<anonymous>";
    return `${sem.operationType} ${label}`;
  }
  return `${sem.name}:${binding.recognition}`;
}

export { checkBodyCompatibility } from "./body/bodyCompatibility.js";
export { bodyShapesMatch } from "./body/bodyMatch.js";
export { checkConsumerContract } from "./consumer/consumerContract.js";
export { checkConsumerSatisfaction } from "./consumer/consumerSatisfaction.js";
export { checkContractAgreement } from "./contract/contractAgreement.js";
export { checkContractConsistency } from "./contract/contractConsistency.js";
export { checkProviderCoverage } from "./coverage/providerCoverage.js";
export { dedupeFindings } from "./dedupe.js";
export { type MatchResult, predicatesMatch, subjectsMatch } from "./match.js";
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
} from "./pairing/pairing.js";
export { checkSemanticBridging } from "./pairing/semanticBridging.js";
export { checkRuntimeConfig } from "./runtime-config/runtimeConfigPairing.js";
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
  const { pairs: restPairs, unmatched: restUnmatched } =
    pairSummaries(summaries);
  const graphql = pairGraphqlOperations(summaries);

  const findings: Finding[] = [...graphql.findings];
  const pairInfo: CheckAllResult["pairs"] = [];

  // REST pairs run through the full check-pair machinery
  // (provider coverage, consumer satisfaction, body / contract
  // checks). GraphQL pairs surface in `pairInfo` for discoverability
  // but skip checkPair — the REST checks all key on status-code +
  // response shape, which doesn't apply to resolvers. Per-semantics
  // checks for GraphQL land alongside `pairGraphqlOperations` when
  // a concrete case motivates them.
  for (const { provider, consumer, key } of restPairs) {
    findings.push(...checkPair(provider, consumer));
    pairInfo.push({
      key,
      provider: provider.identity.name,
      consumer: consumer.identity.name,
    });
  }
  // Track which summaries got at least one graphql pairing so they
  // don't double-surface as unmatched below.
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
  const unmatched = {
    providers: restUnmatched.providers.filter((s) => !graphqlMatched.has(s)),
    consumers: restUnmatched.consumers.filter((s) => !graphqlMatched.has(s)),
    noBinding: restUnmatched.noBinding.filter((s) => !graphqlMatched.has(s)),
  };

  // Layer 2: cross-source contract agreement. Runs independently of
  // pairing — it compares each boundary's declared contracts against
  // each other without caring about consumers. Findings emitted here
  // represent disagreement BETWEEN sources, not inconsistency within
  // a single source (which is Layer 1's job).
  findings.push(...checkContractAgreement(summaries));

  // Cross-shape agreement for React: pair Storybook stub summaries
  // with inferred component summaries by component name and emit
  // findings for scenario-arg-vs-component-input mismatches. Sits
  // alongside contract agreement because it's the same "multiple
  // declared views of the same boundary" shape, just with a
  // different payload (args vs declaredContract).
  findings.push(...checkComponentStoryAgreement(summaries));

  // Runtime-config pairing: cross-source check between
  // infrastructure-stub providers (CFN/SAM Lambda env-var
  // declarations) and code reads of process.env.X. Same shape as the
  // Storybook check — provider declares a contract surface, the
  // checker pairs it against in-scope consumers.
  findings.push(...checkRuntimeConfig(summaries));

  // Relational-storage pairing: pair schema-derived providers
  // (Prisma model declarations, Drizzle pgTable() declarations)
  // against `storageAccess` effects on code summaries. Same
  // provider-declares-contract / consumers-pair-against-it shape;
  // emits the four field-existence findings (read/write unknown,
  // unused, write-only). Constraint findings are reserved in the IR
  // taxonomy but not emitted yet.
  findings.push(...checkRelationalStorage(summaries));

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
      noBinding: unmatched.noBinding.map((s) => s.identity.name),
    },
  };
}
