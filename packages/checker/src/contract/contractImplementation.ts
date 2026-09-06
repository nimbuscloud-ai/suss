// contractImplementation.ts: an extracted handler against the document
// that describes the same route.

import { BOUNDARY_ROLE, summaryIdentifier } from "@suss/behavioral-ir";

import { extractResponseStatus, makeSide } from "../coverage/responseMatch.js";
import { boundaryKey } from "../pairing/pairing.js";
import { summaryWithDefinitionsInlined } from "../spelledOut.js";
import { checkBodiesAgainstDeclared } from "./contractConsistency.js";
import {
  contractDeclaresStatus,
  type DeclaredContract,
  readDeclaredContract,
} from "./declaredContract.js";

import type {
  BehavioralSummary,
  BoundaryBinding,
  Finding,
} from "@suss/behavioral-ir";
import type { ComparedPair } from "../pairing/comparedPair.js";

/**
 * A handler described by a separate document (an OpenAPI file read with
 * `suss contract`) meets that document only here. The document is a
 * stub at the same boundary, and both are providers, so pairing never
 * puts the two together, and `checkContractConsistency` only sees a
 * contract the extractor attached to the handler itself.
 *
 * A status the handler produces that the document leaves out is an
 * error. A status the document declares that no path produces is a
 * warning, and a 5XX one is left alone, since the framework usually
 * produces those. A handler that already has a contract of its own is
 * skipped; `checkContractAgreement` compares the document with it.
 */
export function checkContractImplementation(
  summaries: BehavioralSummary[],
  compared?: ComparedPair[],
): Finding[] {
  const stubsByKey = new Map<string, BehavioralSummary[]>();
  const handlersByKey = new Map<string, BehavioralSummary[]>();

  for (const summary of summaries) {
    const binding = summary.identity.boundaryBinding;
    if (binding === null || BOUNDARY_ROLE[summary.kind] !== "provider") {
      continue;
    }
    const key = boundaryKey(binding);
    if (key === null) {
      continue;
    }
    const contract = readDeclaredContract(summary);
    if (contract === null) {
      addUnder(handlersByKey, key, summary);
    } else if (contract.provenance === "derived") {
      addUnder(stubsByKey, key, summary);
    }
  }

  const findings: Finding[] = [];
  for (const [key, stubs] of stubsByKey) {
    const handlers = handlersByKey.get(key);
    if (handlers === undefined) {
      continue;
    }
    for (const stub of stubs) {
      const contract = readDeclaredContract(stub) as DeclaredContract;
      for (const handler of handlers) {
        // Named types go back into the shapes first, the way `checkPair`
        // does, because comparing two refs only compares their names.
        findings.push(
          ...checkHandlerAgainstDocument(
            summaryWithDefinitionsInlined(handler),
            stub,
            contract,
          ),
        );
        compared?.push({
          key,
          provider: summaryIdentifier(handler),
          consumer: summaryIdentifier(stub),
        });
      }
    }
  }
  return findings;
}

function checkHandlerAgainstDocument(
  handler: BehavioralSummary,
  document: BehavioralSummary,
  contract: DeclaredContract,
): Finding[] {
  const boundary = handler.identity.boundaryBinding as BoundaryBinding;
  const source = document.identity.boundaryBinding?.recognition ?? "contract";
  const findings: Finding[] = [];

  const produced = new Set<number>();
  for (const transition of handler.transitions) {
    const status = extractResponseStatus(transition);
    if (status === null) {
      continue;
    }
    produced.add(status);
    if (contractDeclaresStatus(contract, status)) {
      continue;
    }
    findings.push({
      kind: "providerContractViolation",
      boundary,
      provider: makeSide(handler, transition.id),
      consumer: makeSide(document),
      description: `Handler produces status ${status} which the ${source} document does not declare`,
      severity: "error",
    });
  }

  for (const declared of contract.responses) {
    if (produced.has(declared.statusCode) || declared.statusCode >= 500) {
      continue;
    }
    findings.push({
      kind: "providerContractViolation",
      boundary,
      provider: makeSide(handler),
      consumer: makeSide(document),
      description: `The ${source} document declares response ${declared.statusCode}, and no path in the handler produces it`,
      severity: "warning",
    });
  }

  findings.push(
    ...checkBodiesAgainstDeclared(handler, contract, boundary, document),
  );
  return findings;
}

function addUnder(
  map: Map<string, BehavioralSummary[]>,
  key: string,
  summary: BehavioralSummary,
): void {
  const list = map.get(key);
  if (list === undefined) {
    map.set(key, [summary]);
  } else {
    list.push(summary);
  }
}
