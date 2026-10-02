import { BOUNDARY_ROLE } from "@suss/behavioral-ir";
import {
  bucketsMeet,
  operationKey,
  semanticsAgree,
  spansBuckets,
} from "@suss/ir-core";

import { makeSide } from "../coverage/responseMatch.js";
import { readDeclaredContract } from "./declaredContract.js";
import { handlersServing } from "./operationMatch.js";

import type {
  BehavioralSummary,
  BoundaryBinding,
  Finding,
} from "@suss/behavioral-ir";

/**
 * Reports operations a contract declares that no extracted provider
 * implements.
 *
 * A contract (an OpenAPI spec, a CFN template) that shares no boundary
 * with any extracted provider may describe a service whose code is not
 * in the run, so it is left alone. Once one boundary is shared, the
 * contract and the code describe the same service, and a declared
 * operation with no implementation is a finding. The other direction
 * is not reported. Specs leave out routes such as health checks and
 * docs on purpose, and reporting those would bury the useful findings.
 */
export function checkContractCompleteness(
  summaries: BehavioralSummary[],
): Finding[] {
  const stubsBySource = new Map<string, BehavioralSummary[]>();
  const implemented: BehavioralSummary[] = [];
  const spanning: BoundaryBinding[] = [];

  for (const summary of summaries) {
    const binding = summary.identity.boundaryBinding;
    if (binding === null || BOUNDARY_ROLE[summary.kind] !== "provider") {
      continue;
    }
    const key = operationKey(binding);
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

    implemented.push(summary);
    if (spansBuckets(binding)) {
      spanning.push(binding);
    }
  }

  const findings: Finding[] = [];
  for (const [source, stubs] of stubsBySource) {
    const served = handlersServing(stubs, implemented);
    const isServed = (stub: BehavioralSummary): boolean =>
      (served.get(stub) ?? []).length > 0;
    if (!stubs.some(isServed)) {
      continue;
    }

    for (const stub of stubs) {
      if (isServed(stub) || servedBySpanningRoute(stub, spanning)) {
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

/**
 * Whether a route with a hole spanning segments, such as `/:pk/:file?`,
 * serves the operation, the way pairing lets it meet a client's call.
 */
function servedBySpanningRoute(
  stub: BehavioralSummary,
  spanning: readonly BoundaryBinding[],
): boolean {
  const binding = stub.identity.boundaryBinding;
  return (
    binding !== null &&
    spanning.some(
      (route) =>
        bucketsMeet(route, binding) &&
        semanticsAgree(route.semantics, binding.semantics),
    )
  );
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
