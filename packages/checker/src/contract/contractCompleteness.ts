import { BOUNDARY_ROLE, summaryIdentifier } from "@suss/behavioral-ir";
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
import type { ComparedPair } from "../pairing/comparedPair.js";

/**
 * A contract document whose operations the run compared with nothing:
 * no extracted handler serves one and no consumer calls one. It may
 * describe a service this code calls in a way suss does not read, or a
 * server suss could not read, so its operations are not reported as
 * unimplemented.
 */
export interface UncheckedContract {
  /** The label the document's summaries have as their file, such as `openapi:openapi/ledger.json`. */
  document: string;
  /** The reader that read it, such as `openapi`. */
  source: string;
  /** How many operations it declares. */
  operations: number;
  reason: "notServedOrCalled";
}

/**
 * Reports operations a contract declares that no extracted provider
 * implements.
 *
 * Each document is judged on its own. A document none of whose
 * operations an extracted provider serves may describe a service whose
 * code is not in the run, so its operations are left alone, and when no
 * consumer calls one either it goes in `unchecked`. Once one operation
 * is served, the document and the code describe the same service, and a
 * declared operation with no implementation is a finding. The other
 * direction is not reported. Specs leave out routes such as health
 * checks and docs on purpose, and reporting those would bury the useful
 * findings.
 */
export function checkContractCompleteness(
  summaries: BehavioralSummary[],
  compared: readonly ComparedPair[] = [],
  unchecked?: UncheckedContract[],
): Finding[] {
  const stubsByDocument = new Map<string, BehavioralSummary[]>();
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
      const document = summary.location.file;
      const list = stubsByDocument.get(document);
      if (list !== undefined) {
        list.push(summary);
      } else {
        stubsByDocument.set(document, [summary]);
      }
      continue;
    }

    implemented.push(summary);
    if (spansBuckets(binding)) {
      spanning.push(binding);
    }
  }

  const called = new Set(compared.map((pair) => pair.provider));
  const findings: Finding[] = [];
  for (const [document, stubs] of stubsByDocument) {
    const served = handlersServing(stubs, implemented);
    const isServed = (stub: BehavioralSummary): boolean =>
      (served.get(stub) ?? []).length > 0;
    if (!stubs.some(isServed)) {
      if (!stubs.some((stub) => called.has(summaryIdentifier(stub)))) {
        unchecked?.push(comparedWithNothing(document, stubs));
      }
      continue;
    }

    for (const stub of stubs) {
      if (isServed(stub) || servedBySpanningRoute(stub, spanning)) {
        continue;
      }
      const finding = unimplementedFinding(stub);
      if (finding !== null) {
        findings.push(finding);
      }
    }
  }
  return findings;
}

function comparedWithNothing(
  document: string,
  stubs: readonly BehavioralSummary[],
): UncheckedContract {
  return {
    document,
    source: stubs[0]?.identity.boundaryBinding?.recognition ?? "",
    operations: stubs.length,
    reason: "notServedOrCalled",
  };
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

function unimplementedFinding(stub: BehavioralSummary): Finding | null {
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
    description: `The ${binding.recognition} contract declares ${label} and no extracted provider implements it.`,
    severity: "warning",
  };
}
