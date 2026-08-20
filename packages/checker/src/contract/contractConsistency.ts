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
  readDeclaredContract,
  statusAccessorsFor,
} from "./declaredContract.js";

import type { BehavioralSummary, Finding } from "@suss/behavioral-ir";

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
  // When the contract is "derived" from the same source as the
  // transitions (e.g. an OpenAPI stub's contract extracted from the
  // same operation that produced its transitions), self-comparison is
  // tautological: any mismatch would indicate a bug in the producing
  // pack itself, not a contract violation. Skip the provider-vs-its-own-
  // contract checks; consumer-vs-contract checks still run because the
  // consumer is always an independent observation.
  const skipSelfComparison = contract.provenance === "derived";

  if (!skipSelfComparison) {
    for (const gap of provider.gaps) {
      // A gap saying part of the handler went unread means the pack has
      // no shape for what it returns, which is a limit in what suss
      // could read rather than a fault in the handler.
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
  // it is handled when any member is, and unhandled as one thing.
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
      // The branch never runs if the contract is right, and nothing
      // misreads at runtime either way; dead code is a judgement, the
      // same call deadConsumerBranch makes (#471).
      severity: "warning",
    });
  }

  if (skipSelfComparison) {
    return findings;
  }

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
          consumer: makeSide(consumer),
          description: `Handler returns a body on status ${declared.statusCode} that does not match the declared schema`,
          severity: "error",
        });
        continue;
      }
      findings.push({
        kind: "lowConfidence",
        boundary,
        provider: makeSide(provider, pt.id),
        consumer: makeSide(consumer),
        description: `Handler returns a body on status ${declared.statusCode} that could not be compared with the declared schema`,
        severity: "info",
      });
    }
  }

  return findings;
}
