/**
 * Checks that the contracts several providers declare for one boundary
 * agree with each other. An OpenAPI stub, a CloudFormation stub and an
 * extracted handler can each declare a contract for the same route.
 * `checkContractConsistency` compares each provider with its own
 * contract, and this pass compares the contracts with each other.
 *
 * A contract is a list of `{ statusCode, body }` entries with no
 * conditions, so the pass compares the sets of statuses, and then the
 * body shapes at each status the sources share.
 */

import { summaryRef } from "@suss/behavioral-ir";

import { bodyShapesMatch } from "../body/bodyMatch.js";
import { makeSide } from "../coverage/responseMatch.js";
import { boundaryKey } from "../pairing/pairing.js";
import {
  contractDeclaresStatus,
  readDeclaredContract,
} from "./declaredContract.js";

import type {
  BehavioralSummary,
  BoundaryBinding,
  Finding,
} from "@suss/behavioral-ir";
import type { DeclaredContract } from "./declaredContract.js";

interface ContractSource {
  summary: BehavioralSummary;
  contract: DeclaredContract;
}

/**
 * Report every boundary where two or more declared contracts disagree.
 * This runs from `checkAll`, because `checkPair` sees one pair at a
 * time and never sees the other providers at a boundary.
 */
export function checkContractAgreement(
  summaries: BehavioralSummary[],
): Finding[] {
  const byBoundary = groupProvidersByBoundary(summaries);
  const findings: Finding[] = [];

  for (const { boundary, sources } of byBoundary) {
    if (sources.length < 2) {
      continue;
    }
    findings.push(...compareSources(boundary, sources));
  }

  return findings;
}

interface BoundaryGroup {
  boundary: BoundaryBinding;
  sources: ContractSource[];
}

function groupProvidersByBoundary(
  summaries: BehavioralSummary[],
): BoundaryGroup[] {
  const groups = new Map<string, BoundaryGroup>();

  for (const summary of summaries) {
    const binding = summary.identity.boundaryBinding;
    if (binding === null) {
      continue;
    }
    const key = boundaryKey(binding);
    if (key === null) {
      continue;
    }
    const contract = readDeclaredContract(summary);
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

function compareSources(
  boundary: BoundaryBinding,
  sources: ContractSource[],
): Finding[] {
  const findings: Finding[] = [];

  // A source declaring "4XX" or `default` also declares 404, since a
  // range is a weaker statement about the same status.
  const statusAttribution = new Map<number, Set<string>>();
  const allSourceIds = sources.map((s) => s.summary.identity.name);
  const allSourceSet = new Set(allSourceIds);

  const literalStatuses = new Set(
    sources.flatMap((s) => s.contract.responses.map((r) => r.statusCode)),
  );
  for (const status of literalStatuses) {
    statusAttribution.set(
      status,
      new Set(
        sources
          .filter((s) => contractDeclaresStatus(s.contract, status))
          .map((s) => s.summary.identity.name),
      ),
    );
  }

  for (const [status, declaringSources] of statusAttribution) {
    if (declaringSources.size === allSourceSet.size) {
      continue;
    }
    const missing = [...allSourceIds].filter((id) => !declaringSources.has(id));
    const representative =
      sources.find((s) => declaringSources.has(s.summary.identity.name)) ??
      sources[0];
    const sortedSources = [...sources].map((s) => summaryRef(s.summary));
    sortedSources.sort();

    findings.push({
      kind: "contractDisagreement",
      boundary,
      provider: makeSide(representative.summary),
      consumer: makeSide(representative.summary), // no consumer is involved
      description: `Sources disagree on status ${status} at ${boundaryKey(boundary) ?? "this boundary"}: declared by [${[...declaringSources].sort().join(", ")}], not declared by [${missing.sort().join(", ")}]`,
      severity: "warning",
      sources: sortedSources,
    });
  }

  // Each body at a shared status is compared with the first source's,
  // which gives one finding per disagreeing source instead of one per
  // pair of sources.
  for (const [status, declaringSources] of statusAttribution) {
    const contributors = sources.filter((s) =>
      declaringSources.has(s.summary.identity.name),
    );
    if (contributors.length < 2) {
      continue;
    }
    const baseline = contributors.find(
      (s) =>
        s.contract.responses.find((r) => r.statusCode === status)?.body !==
        null,
    );
    if (baseline === undefined) {
      continue;
    }
    const baselineBody = baseline.contract.responses.find(
      (r) => r.statusCode === status,
    )?.body;
    if (baselineBody === null || baselineBody === undefined) {
      continue;
    }

    for (const other of contributors) {
      if (other === baseline) {
        continue;
      }
      const otherBody = other.contract.responses.find(
        (r) => r.statusCode === status,
      )?.body;
      if (otherBody === null || otherBody === undefined) {
        continue; // a status with no body agrees with any body
      }
      const result = bodyShapesMatch(baselineBody, otherBody);
      if (result === "match") {
        continue;
      }
      if (result === "unknown") {
        continue; // a comparison that cannot be settled is not a disagreement
      }
      findings.push({
        kind: "contractDisagreement",
        boundary,
        provider: makeSide(baseline.summary),
        consumer: makeSide(other.summary),
        description: `Sources disagree on body shape for status ${status} at ${boundaryKey(boundary) ?? "this boundary"}: ${baseline.summary.identity.name} and ${other.summary.identity.name} declare incompatible schemas`,
        severity: "warning",
        sources: [
          summaryRef(baseline.summary),
          summaryRef(other.summary),
        ].sort(),
      });
    }
  }

  return findings;
}
