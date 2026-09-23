import { bodyShapesMatch } from "../body/bodyMatch.js";
import {
  consumerExpectedStatuses,
  extractResponseStatus,
  isSuccessStatus,
  makeBoundary,
  makeSide,
} from "../coverage/responseMatch.js";
import { consumerHandlesStatus } from "../coverage/statusRanges.js";
import {
  contractDeclaresStatus,
  type DeclaredContract,
  readDeclaredContract,
  statusAccessorsFor,
} from "./declaredContract.js";

import type {
  BehavioralSummary,
  BoundaryBinding,
  Finding,
} from "@suss/behavioral-ir";

export function checkContractConsistency(
  provider: BehavioralSummary,
  consumer: BehavioralSummary,
): Finding[] {
  const contract = readDeclaredContract(provider);
  if (!contract) {
    return [];
  }

  const findings: Finding[] = [];
  const boundary = makeBoundary(provider, consumer);
  // A derived contract comes from the same source as the transitions, so
  // a mismatch between them would be a pack bug. The provider checks are
  // skipped for it, and the consumer checks still run.
  const skipSelfComparison = contract.provenance === "derived";

  if (!skipSelfComparison) {
    for (const gap of provider.gaps) {
      // An unread outcome is a part of the handler suss could not read,
      // so it says nothing about the handler and gets low confidence.
      if (gap.type === "unreadOutcome") {
        findings.push({
          kind: "lowConfidence",
          boundary,
          provider: makeSide(provider),
          consumer: makeSide(consumer),
          description: gap.description,
          severity: "info",
        });
        continue;
      }
      findings.push({
        kind: "providerContractViolation",
        boundary,
        provider: makeSide(provider),
        consumer: makeSide(consumer),
        description: gap.description,
        severity: "error",
      });
    }
  }

  const declaredStatuses = new Set(contract.responses.map((r) => r.statusCode));
  const statusAccessors = statusAccessorsFor(consumer);

  const consumerExplicit = new Set<number>();
  let consumerHasDefault = false;
  for (const ct of consumer.transitions) {
    if (ct.isDefault) {
      consumerHasDefault = true;
    }
    for (const s of consumerExpectedStatuses(ct, statusAccessors)) {
      consumerExplicit.add(s);
    }
  }
  const consumerHandles = consumerHandlesStatus(consumer);

  for (const declared of declaredStatuses) {
    if (consumerHandles(declared)) {
      continue;
    }
    if (consumerHasDefault && isSuccessStatus(declared)) {
      continue;
    }
    findings.push({
      kind: "consumerContractViolation",
      boundary,
      provider: makeSide(provider),
      consumer: makeSide(consumer),
      description: `Contract declares response ${declared} but consumer does not handle it`,
      severity: "warning",
    });
  }

  // A declared range promises one response with some status in it, so
  // handling any member handles the range, and an unhandled range gets
  // one finding.
  for (const range of contract.responseRanges) {
    const someMemberHandled = (): boolean => {
      for (let status = range.min; status <= range.max; status++) {
        if (consumerHandles(status)) {
          return true;
        }
        if (consumerHasDefault && isSuccessStatus(status)) {
          return true;
        }
      }
      return false;
    };
    if (someMemberHandled()) {
      continue;
    }
    findings.push({
      kind: "consumerContractViolation",
      boundary,
      provider: makeSide(provider),
      consumer: makeSide(consumer),
      description: `Contract declares ${range.spec} responses but consumer handles none of them`,
      severity: "warning",
    });
  }

  for (const expected of consumerExplicit) {
    if (contractDeclaresStatus(contract, expected)) {
      continue;
    }
    findings.push({
      kind: "consumerContractViolation",
      boundary,
      provider: makeSide(provider),
      consumer: makeSide(consumer),
      description: `Consumer handles status ${expected} but contract does not declare it`,
      // If the contract is right the branch never runs, and nothing is
      // misread either way, so this is a warning like deadConsumerBranch
      // (#471).
      severity: "warning",
    });
  }

  if (skipSelfComparison) {
    return findings;
  }

  findings.push(
    ...checkBodiesAgainstDeclared(provider, contract, boundary, consumer),
  );

  return findings;
}

/**
 * Compare each body the provider returns on a declared status with the
 * body the contract declares for it. `other` is the summary on the
 * finding's consumer side: the caller in a pair, or the document the
 * contract came from when no caller is in the run.
 */
export function checkBodiesAgainstDeclared(
  provider: BehavioralSummary,
  contract: DeclaredContract,
  boundary: BoundaryBinding,
  other: BehavioralSummary,
): Finding[] {
  const findings: Finding[] = [];

  for (const declared of contract.responses) {
    if (declared.body === null) {
      continue;
    }
    for (const pt of provider.transitions) {
      if (pt.output.type !== "response") {
        continue;
      }
      const status = extractResponseStatus(pt);
      if (status !== declared.statusCode) {
        continue;
      }
      const actualBody = pt.output.body;
      if (actualBody === null) {
        continue;
      }
      const result = bodyShapesMatch(actualBody, declared.body);
      if (result === "match") {
        continue;
      }
      if (result === "nomatch") {
        findings.push({
          kind: "providerContractViolation",
          boundary,
          provider: makeSide(provider, pt.id),
          consumer: makeSide(other),
          description: `Handler returns a body on status ${declared.statusCode} that does not match the declared schema`,
          severity: "error",
        });
        continue;
      }
      findings.push({
        kind: "lowConfidence",
        boundary,
        provider: makeSide(provider, pt.id),
        consumer: makeSide(other),
        description: `Handler returns a body on status ${declared.statusCode} that could not be compared with the declared schema`,
        severity: "info",
      });
    }
  }

  return findings;
}
