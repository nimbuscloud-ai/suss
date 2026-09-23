/**
 * Compares the GraphQL contracts that two or more sources declare for
 * the same `gql:Type.field` boundary, under
 * `metadata.graphql.declaredContract`. `@suss/contract-graphql` writes
 * these contracts from an SDL file.
 *
 * A disagreement is reported as `contractDisagreement`, the same kind
 * REST agreement uses, with the GraphQL detail in the description.
 */

import { summaryRef } from "@suss/behavioral-ir";

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
 * Group GraphQL resolver contracts by boundary key and report every
 * boundary where two sources disagree. Two sources disagree when their
 * return types do not match under `bodyShapesMatch`, or when an
 * argument appears in only one of them, or has types that do not
 * match.
 *
 * Whether an argument is required is not compared. Adding a required
 * argument breaks a caller and not a resolver, and these contracts do
 * not record which side they describe.
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
          summaryRef(baseline.summary),
          summaryRef(other.summary),
        ].sort(),
      });
    }

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
              summaryRef(baseline.summary),
              summaryRef(other.summary),
            ].sort(),
          });
        }
        continue;
      }
      // A derived contract may leave out arguments its source did not
      // list, so a missing argument counts only when both contracts are
      // independent.
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
            summaryRef(baseline.summary),
            summaryRef(other.summary),
          ].sort(),
        });
      }
    }
  }

  return findings;
}
