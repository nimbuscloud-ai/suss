// contract-agreement.ts — Layer 2 cross-source contract consistency.
//
// When multiple providers describe the same boundary (an OpenAPI stub,
// a CloudFormation stub, an extracted handler, …) each may carry its
// own declaredContract. Layer 1 (checkContractConsistency) tells us
// whether *each* provider is consistent with its *own* contract. This
// layer tells us whether the contracts **agree with each other**.
//
// Cross-source contract comparison is strictly simpler than
// cross-source transition comparison: contracts are just
// `{ statusCode, body }` tuples, no conditions or platform-injected
// transitions. Set comparison on status codes, shape comparison on
// matching body schemas.
//
// Emits `contractDisagreement` findings. No IR or checker change is
// required for Layer 1; this is additive.

import { bodyShapesMatch } from "./body-match.js";
import { readDeclaredContract } from "./declared-contract.js";
import { boundaryKey } from "./pairing.js";
import { makeSide } from "./response-match.js";

import type {
  BehavioralSummary,
  BoundaryBinding,
  Finding,
} from "@suss/behavioral-ir";
import type { DeclaredContract } from "./declared-contract.js";

interface ContractSource {
  summary: BehavioralSummary;
  contract: DeclaredContract;
}

/**
 * Scan a flat list of summaries and emit findings for every boundary
 * where multiple sources carry declared contracts that disagree.
 * Sources with no declared contract are ignored. Boundaries described
 * by only one source are ignored (no comparison to make).
 *
 * Intended to run at the `checkAll` level, where multiple summaries
 * per boundary are available. `checkPair` operates on one pair at a
 * time and has no way to see sibling providers.
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

  // --- Status-set disagreements ------------------------------------------
  // Build `status -> Set<sourceSummary>` so each status is attributed
  // to exactly the sources that declared it. A disagreement exists iff
  // the attribution set is a proper subset of all sources.
  const statusAttribution = new Map<number, Set<string>>();
  const allSourceIds = sources.map((s) => s.summary.identity.name);
  const allSourceSet = new Set(allSourceIds);

  for (const src of sources) {
    const id = src.summary.identity.name;
    for (const r of src.contract.responses) {
      const set = statusAttribution.get(r.statusCode);
      if (set === undefined) {
        statusAttribution.set(r.statusCode, new Set([id]));
      } else {
        set.add(id);
      }
    }
  }

  for (const [status, declaringSources] of statusAttribution) {
    if (declaringSources.size === allSourceSet.size) {
      continue; // unanimous
    }
    const missing = [...allSourceIds].filter((id) => !declaringSources.has(id));
    const representative =
      sources.find((s) => declaringSources.has(s.summary.identity.name)) ??
      sources[0];
    const sortedSources = [...sources].map(
      (s) => `${s.summary.location.file}::${s.summary.identity.name}`,
    );
    sortedSources.sort();

    findings.push({
      kind: "contractDisagreement",
      boundary,
      provider: makeSide(representative.summary),
      consumer: makeSide(representative.summary), // no consumer involved; reuse the representative
      description: `Sources disagree on status ${status} at ${boundaryKey(boundary) ?? "this boundary"}: declared by [${[...declaringSources].sort().join(", ")}], not declared by [${missing.sort().join(", ")}]`,
      severity: "warning",
      sources: sortedSources,
    });
  }

  // --- Body-shape disagreements at shared statuses -----------------------
  // For each (status, source) tuple where both sources declare a body,
  // check shape compatibility in both directions. Only flag at the
  // first-vs-each-other level to avoid N×(N-1)/2 expansion — one
  // finding per (status, disagreeing-pair-of-sources) is enough signal.
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
      continue; // nobody declared a body for this status; nothing to compare
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
        continue; // this source didn't constrain the body; no disagreement
      }
      const result = bodyShapesMatch(baselineBody, otherBody);
      if (result === "match") {
        continue;
      }
      if (result === "unknown") {
        continue; // punt on unknowns — Layer 1 already surfaces these
      }
      findings.push({
        kind: "contractDisagreement",
        boundary,
        provider: makeSide(baseline.summary),
        consumer: makeSide(other.summary),
        description: `Sources disagree on body shape for status ${status} at ${boundaryKey(boundary) ?? "this boundary"}: ${baseline.summary.identity.name} and ${other.summary.identity.name} declare incompatible schemas`,
        severity: "warning",
        sources: [
          `${baseline.summary.location.file}::${baseline.summary.identity.name}`,
          `${other.summary.location.file}::${other.summary.identity.name}`,
        ].sort(),
      });
    }
  }

  return findings;
}
