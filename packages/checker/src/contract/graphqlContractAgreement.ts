// graphqlContractAgreement.ts — sibling of contractAgreement.ts for
// the GraphQL response model.
//
// When two or more sources describe the same `gql:Type.field` boundary
// and each carries `metadata.graphql.declaredContract`, compare them.
// Today's contributors include `@suss/contract-graphql` (SDL → contract
// summaries). Future server-side population from
// `framework-nestjs-graphql` (decorator return types) and Apollo
// resolverMap (SDL stored on the resolver's metadata) will let this
// fire on contract-vs-implementation mismatches in real codebases.
//
// Reuses the existing `contractDisagreement` finding kind; the
// description carries the GraphQL-specific shape disagreement detail.
//
// Provenance gate: skip pairs where any contributor's contract is
// `derived` AND the other side is the same source (tautological self-
// comparison). Cross-source comparison still runs even when one side
// is `derived` — that's the point.

import { bodyShapesMatch } from "../body/bodyMatch.js";
import { makeSide } from "../coverage/responseMatch.js";
import { boundaryKey } from "../pairing/pairing.js";
import {
  type GraphqlDeclaredContract,
  readGraphqlDeclaredContract,
} from "./graphqlContract.js";

import type {
  BehavioralSummary,
  BoundaryBinding,
  Finding,
} from "@suss/behavioral-ir";

interface GraphqlContractSource {
  summary: BehavioralSummary;
  contract: GraphqlDeclaredContract;
}

interface GraphqlBoundaryGroup {
  boundary: BoundaryBinding;
  sources: GraphqlContractSource[];
}

/**
 * Walk a flat summary list, group sources by graphql-resolver
 * boundary key, and emit `contractDisagreement` findings for every
 * boundary where 2+ sources declare contracts that disagree.
 *
 * Disagreement axes (v0):
 *   - return type incompatible (via bodyShapesMatch — same machinery
 *     REST agreement uses)
 *   - argument set differs (a present on one source, absent on the
 *     other; or types incompatible at a shared name)
 *
 * Argument REQUIRED-ness is recorded but not flagged as disagreement
 * yet — the precise rule (does adding required args break
 * compatibility?) depends on whether the contract is provider-side
 * or consumer-side, which we don't separate cleanly today. Tracked
 * as a follow-up.
 */
export function checkGraphqlContractAgreement(
  summaries: BehavioralSummary[],
): Finding[] {
  const groups = groupGraphqlProvidersByBoundary(summaries);
  const findings: Finding[] = [];
  for (const { boundary, sources } of groups) {
    if (sources.length < 2) {
      continue;
    }
    findings.push(...compareGraphqlSources(boundary, sources));
  }
  return findings;
}

function groupGraphqlProvidersByBoundary(
  summaries: BehavioralSummary[],
): GraphqlBoundaryGroup[] {
  const groups = new Map<string, GraphqlBoundaryGroup>();
  for (const summary of summaries) {
    const binding = summary.identity.boundaryBinding;
    if (binding === null) {
      continue;
    }
    if (binding.semantics.name !== "graphql-resolver") {
      continue;
    }
    const key = boundaryKey(binding);
    if (key === null) {
      continue;
    }
    const contract = readGraphqlDeclaredContract(summary);
    if (contract === null) {
      continue;
    }
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { boundary: binding, sources: [{ summary, contract }] });
    } else {
      existing.sources.push({ summary, contract });
    }
  }
  return [...groups.values()];
}

function compareGraphqlSources(
  boundary: BoundaryBinding,
  sources: GraphqlContractSource[],
): Finding[] {
  const findings: Finding[] = [];
  const baseline = sources[0];
  if (baseline === undefined) {
    return findings;
  }
  const key = boundaryKey(boundary) ?? "this resolver";

  for (let i = 1; i < sources.length; i += 1) {
    const other = sources[i];
    if (other === undefined) {
      continue;
    }

    // Return-type compatibility — same matcher REST agreement uses.
    const returnMatch = bodyShapesMatch(
      baseline.contract.returnType,
      other.contract.returnType,
    );
    if (returnMatch === "nomatch") {
      findings.push({
        kind: "contractDisagreement",
        boundary,
        provider: makeSide(baseline.summary),
        consumer: makeSide(other.summary),
        description: `GraphQL sources disagree on return type at ${key}: ${baseline.summary.identity.name} and ${other.summary.identity.name} declare incompatible types`,
        severity: "warning",
        sources: [
          `${baseline.summary.location.file}::${baseline.summary.identity.name}`,
          `${other.summary.location.file}::${other.summary.identity.name}`,
        ].sort(),
      });
    }

    // Argument-set comparison: name-based union, then per-name type
    // check on shared names.
    const baseArgs = new Map(baseline.contract.args.map((a) => [a.name, a]));
    const otherArgs = new Map(other.contract.args.map((a) => [a.name, a]));
    const allNames = new Set([...baseArgs.keys(), ...otherArgs.keys()]);

    for (const name of allNames) {
      const a = baseArgs.get(name);
      const b = otherArgs.get(name);
      if (a !== undefined && b !== undefined) {
        const argMatch = bodyShapesMatch(a.type, b.type);
        if (argMatch === "nomatch") {
          findings.push({
            kind: "contractDisagreement",
            boundary,
            provider: makeSide(baseline.summary),
            consumer: makeSide(other.summary),
            description: `GraphQL sources disagree on argument "${name}" type at ${key}: ${baseline.summary.identity.name} and ${other.summary.identity.name} declare incompatible argument types`,
            severity: "warning",
            sources: [
              `${baseline.summary.location.file}::${baseline.summary.identity.name}`,
              `${other.summary.location.file}::${other.summary.identity.name}`,
            ].sort(),
          });
        }
        continue;
      }
      // Argument present on one side and missing from the other.
      // Only flag when both contracts are "independent" — derived
      // contracts often summarise differently and missing args may
      // just mean the source didn't enumerate them.
      if (
        baseline.contract.provenance === "independent" &&
        other.contract.provenance === "independent"
      ) {
        const declaring = a !== undefined ? baseline : other;
        const missing = a !== undefined ? other : baseline;
        findings.push({
          kind: "contractDisagreement",
          boundary,
          provider: makeSide(declaring.summary),
          consumer: makeSide(missing.summary),
          description: `GraphQL sources disagree on argument set at ${key}: ${declaring.summary.identity.name} declares argument "${name}" but ${missing.summary.identity.name} omits it`,
          severity: "warning",
          sources: [
            `${baseline.summary.location.file}::${baseline.summary.identity.name}`,
            `${other.summary.location.file}::${other.summary.identity.name}`,
          ].sort(),
        });
      }
    }
  }

  return findings;
}
