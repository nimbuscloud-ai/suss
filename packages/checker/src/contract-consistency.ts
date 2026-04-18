import { bodyShapesMatch } from "./body-match.js";
import {
  readDeclaredContract,
  statusAccessorsFor,
} from "./declared-contract.js";
import {
  consumerExpectedStatuses,
  extractResponseStatus,
  makeBoundary,
  makeSide,
} from "./response-match.js";

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
  // tautological — any mismatch would indicate a bug in the producing
  // pack itself, not a contract violation. Skip the provider-vs-its-own-
  // contract checks; consumer-vs-contract checks still run because the
  // consumer is always an independent observation.
  const skipSelfComparison = contract.provenance === "derived";

  if (!skipSelfComparison) {
    for (const gap of provider.gaps) {
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

  for (const declared of declaredStatuses) {
    if (consumerExplicit.has(declared)) {
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

  for (const expected of consumerExplicit) {
    if (declaredStatuses.has(expected)) {
      continue;
    }
    findings.push({
      kind: "consumerContractViolation",
      boundary,
      provider: makeSide(provider),
      consumer: makeSide(consumer),
      description: `Consumer handles status ${expected} but contract does not declare it`,
      severity: "error",
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
          description: `Handler transition ${pt.id} returns a body shape incompatible with the declared schema for status ${declared.statusCode}`,
          severity: "error",
        });
        continue;
      }
      findings.push({
        kind: "lowConfidence",
        boundary,
        provider: makeSide(provider, pt.id),
        consumer: makeSide(consumer),
        description: `Handler transition ${pt.id} body shape cannot be compared to the declared schema for status ${declared.statusCode}`,
        severity: "info",
      });
    }
  }

  return findings;
}

function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}
