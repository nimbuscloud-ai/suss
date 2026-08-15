// contract-completeness.ts: an operation a contract declares that no
// extracted provider implements.

import { BOUNDARY_ROLE } from "@suss/behavioral-ir";

import { makeSide } from "../coverage/responseMatch.js";
import { boundaryKey } from "../pairing/pairing.js";
import { readDeclaredContract } from "./declaredContract.js";

import type { BehavioralSummary, Finding } from "@suss/behavioral-ir";

/**
 * A stub from a contract pack (an OpenAPI spec, a CFN template) that
 * shares no boundary with any extracted provider says nothing: the
 * spec may describe a service whose code is not in the run. Once at
 * least one boundary is shared, the spec and the codebase describe the
 * same service, and a declared operation with no implementation is a
 * finding. The reverse direction (a route in code the spec never
 * declares) stays out, because infra routes (health, the served spec,
 * docs) are unlisted on purpose and flagging them would bury the
 * signal.
 */
export function checkContractCompleteness(
  summaries: BehavioralSummary[],
): Finding[] {
  const stubsBySource = new Map<string, BehavioralSummary[]>();
  const implementedKeys = new Set<string>();

  for (const summary of summaries) {
    const binding = summary.identity.boundaryBinding;
    if (binding === null || BOUNDARY_ROLE[summary.kind] !== "provider") {
      continue;
    }
    const key = boundaryKey(binding);
    if (key === null) {
      continue;
    }

    if (readDeclaredContract(summary)?.provenance === "derived") {
      const source = binding.recognition;
      const list = stubsBySource.get(source);
      if (list !== undefined) {
        list.push(summary);
      } else {
        stubsBySource.set(source, [summary]);
      }
      continue;
    }

    implementedKeys.add(key);
  }

  const findings: Finding[] = [];
  for (const [source, stubs] of stubsBySource) {
    const overlaps = stubs.some((s) => implementedKeys.has(stubKey(s) ?? ""));
    if (!overlaps) {
      continue;
    }

    for (const stub of stubs) {
      const key = stubKey(stub);
      if (key === null || implementedKeys.has(key)) {
        continue;
      }
      const finding = unimplementedFinding(source, stub);
      if (finding !== null) {
        findings.push(finding);
      }
    }
  }
  return findings;
}

function stubKey(stub: BehavioralSummary): string | null {
  const binding = stub.identity.boundaryBinding;
  return binding === null ? null : boundaryKey(binding);
}

function unimplementedFinding(
  source: string,
  stub: BehavioralSummary,
): Finding | null {
  const binding = stub.identity.boundaryBinding;
  if (binding === null) {
    return null;
  }
  const semantics = binding.semantics;
  const label =
    semantics.name === "rest"
      ? `${semantics.method ?? "?"} ${semantics.path ?? "?"}`
      : stub.identity.name;
  return {
    kind: "contractOperationUnimplemented",
    boundary: binding,
    provider: makeSide(stub),
    consumer: makeSide(stub),
    description: `The ${source} contract declares ${label} and no extracted provider implements it.`,
    severity: "warning",
  };
}
