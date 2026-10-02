import {
  BOUNDARY_ROLE,
  readHttpMetadata,
  readWrapperMetadata,
  summaryIdentifier,
  wrapperIndex,
} from "@suss/behavioral-ir";
import { operationKey } from "@suss/ir-core";

import {
  extractResponseStatus,
  makeSide,
  makeSideOfEach,
  nothingWasRead,
} from "../coverage/responseMatch.js";
import { boundaryKey, servingFunction } from "../pairing/pairing.js";
import { summaryWithDefinitionsInlined } from "../spelledOut.js";
import { checkBodiesAgainstDeclared } from "./contractConsistency.js";
import {
  contractDeclaresStatus,
  type DeclaredContract,
  readDeclaredContract,
} from "./declaredContract.js";
import { handlersServing } from "./operationMatch.js";
import {
  lowestStatusSentUnread,
  reachedThroughUnreadCondition,
} from "./partlyRead.js";

import type {
  BehavioralSummary,
  BoundaryBinding,
  Finding,
  Transition,
  WrapperIndex,
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
  const stubs: BehavioralSummary[] = [];
  const handlers: BehavioralSummary[] = [];

  for (const summary of summaries) {
    const binding = summary.identity.boundaryBinding;
    if (
      binding === null ||
      BOUNDARY_ROLE[summary.kind] !== "provider" ||
      operationKey(binding) === null
    ) {
      continue;
    }
    const contract = readDeclaredContract(summary);
    if (contract === null) {
      handlers.push(summary);
    } else if (contract.provenance === "derived") {
      stubs.push(summary);
    }
  }

  const wrappers = wrapperIndex(summaries);
  const findings: Finding[] = [];
  for (const [stub, sameRoute] of handlersServing(stubs, handlers)) {
    const contract = readDeclaredContract(stub) as DeclaredContract;
    const serving = describedBy(stub, sameRoute);
    // Named types go back into the shapes first, the way `checkPair`
    // does, because comparing two refs only compares their names.
    const judged = serving.map((handler) => ({
      handler,
      judged: checkHandlerAgainstDocument(
        summaryWithDefinitionsInlined(handler),
        stub,
        contract,
        wrappers,
      ),
    }));
    findings.push(...sharedByEveryFunction(judged));
    for (const handler of serving) {
      compared?.push({
        key: boundaryKeyOfHandler(handler) ?? summaryIdentifier(stub),
        provider: summaryIdentifier(handler),
        consumer: summaryIdentifier(stub),
      });
    }
  }
  return findings;
}

/**
 * A finding about one handler, beside what it says about the handler
 * with the handler's own details left out, so the same finding about
 * two functions can be recognised.
 */
interface Judged {
  finding: Finding;
  claim: string;
}

function judged(finding: Finding, claim = finding.description): Judged {
  return { finding, claim: `${finding.kind}|${claim}` };
}

/**
 * The handlers an operation describes, out of every handler on its
 * route. When two functions serve the route, such as two API versions a
 * header picks between, an operation named after one of them, the way a
 * generator writes `OrdersController_2024_06_11_getOrder`, describes
 * that one. Otherwise nothing says which, and all of them are judged.
 */
function describedBy(
  stub: BehavioralSummary,
  serving: readonly BehavioralSummary[],
): readonly BehavioralSummary[] {
  const operation = comparableName(stub.identity.name);
  const named = serving.filter(
    (handler) => comparableName(handler.identity.name) === operation,
  );
  return new Set(named.map(servingFunction)).size === 1 ? named : serving;
}

function comparableName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * The findings to report for one operation. When two different
 * functions serve it and nothing says which one the document describes,
 * a finding every one of them shows is true whichever it is, so it is
 * reported for each of them. One only some of them show is held back. A
 * note about what suss could not read is kept either way.
 */
function sharedByEveryFunction(
  byHandler: readonly { handler: BehavioralSummary; judged: Judged[] }[],
): Finding[] {
  const claimsByFunction = new Map<string, Set<string>>();
  for (const { handler, judged: found } of byHandler) {
    const key = servingFunction(handler);
    const claims = claimsByFunction.get(key) ?? new Set<string>();
    for (const { claim } of found) {
      claims.add(claim);
    }
    claimsByFunction.set(key, claims);
  }

  const everyFunction = [...claimsByFunction.values()];
  return byHandler.flatMap(({ judged: found }) =>
    found
      .filter(
        ({ finding, claim }) =>
          finding.kind === "lowConfidence" ||
          everyFunction.every((claims) => claims.has(claim)),
      )
      .map(({ finding }) => finding),
  );
}

function checkHandlerAgainstDocument(
  handler: BehavioralSummary,
  document: BehavioralSummary,
  contract: DeclaredContract,
  wrappers: WrapperIndex,
): Judged[] {
  const boundary = handler.identity.boundaryBinding as BoundaryBinding;
  const source = document.identity.boundaryBinding?.recognition ?? "contract";
  if (nothingWasRead(handler)) {
    return [
      judged({
        kind: "lowConfidence",
        boundary,
        provider: makeSide(handler),
        consumer: makeSide(document),
        description: `The handler could not be read, so it was not compared with the ${source} document`,
        severity: "info",
      }),
    ];
  }

  const findings: Judged[] = [];

  const produced = new Set<number>();
  const undeclared = new Map<number, Transition[]>();
  for (const transition of handler.transitions) {
    const status = extractResponseStatus(transition);
    if (status === null) {
      continue;
    }
    produced.add(status);
    // Only a path suss read in full shows the handler can send it.
    if (
      contractDeclaresStatus(contract, status) ||
      reachedThroughUnreadCondition(handler, transition)
    ) {
      continue;
    }
    undeclared.set(status, [...(undeclared.get(status) ?? []), transition]);
  }

  // One finding per status, however many paths send it.
  for (const [status, transitions] of undeclared) {
    const claim = `Handler produces status ${status} which the ${source} document does not declare`;
    findings.push(
      judged(
        {
          kind: "providerContractViolation",
          boundary,
          provider: makeSideOfEach(
            handler,
            transitions.map((t) => t.id),
          ),
          consumer: makeSide(document),
          description: `${claim}${sentByEach(transitions)}`,
          severity: "error",
        },
        claim,
      ),
    );
  }

  const unreadFrom = lowestStatusSentUnread(handler, wrappers);
  // A status the handler's own code declares is in a generated document
  // because of that declaration, which says nothing about a path.
  const declaredInCode = new Set(readHttpMetadata(handler)?.declaredStatuses);
  for (const declared of contract.responses) {
    if (
      produced.has(declared.statusCode) ||
      declared.statusCode >= 500 ||
      declaredInCode.has(declared.statusCode) ||
      declared.statusCode >= unreadFrom
    ) {
      continue;
    }
    findings.push(
      judged({
        kind: "providerContractViolation",
        boundary,
        provider: makeSide(handler),
        consumer: makeSide(document),
        description: `The ${source} document declares response ${declared.statusCode}, and no path in the handler produces it`,
        severity: "warning",
      }),
    );
  }

  findings.push(
    ...checkBodiesAgainstDeclared(handler, contract, boundary, document).map(
      (finding) => judged(finding),
    ),
  );
  return findings;
}

/**
 * Which code sends one status, when more than one piece of code does:
 * the handler's own body, or a wrapper such as a filter composed into it.
 * Empty when one piece of code sends it, so a single path keeps the
 * description it always had.
 */
function sentByEach(transitions: readonly Transition[]): string {
  const senders = [
    ...new Set(
      transitions.map(
        (t) => readWrapperMetadata(t)?.from?.name ?? "the handler",
      ),
    ),
  ];
  if (senders.length < 2) {
    return "";
  }
  const last = senders.pop() as string;
  return `. It comes from ${senders.join(", ")} and ${last}`;
}

function boundaryKeyOfHandler(handler: BehavioralSummary): string | null {
  const binding = handler.identity.boundaryBinding;
  return binding === null ? null : boundaryKey(binding);
}
