import {
  consumerExpectedStatuses,
  makeBoundary,
  makeSide,
} from "./response-match.js";

import type { BehavioralSummary, Finding } from "@suss/behavioral-ir";

interface DeclaredContract {
  responses: Array<{ statusCode: number }>;
}

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

  const declaredStatuses = new Set(contract.responses.map((r) => r.statusCode));

  const consumerExplicit = new Set<number>();
  let consumerHasDefault = false;
  for (const ct of consumer.transitions) {
    if (ct.isDefault) {
      consumerHasDefault = true;
    }
    for (const s of consumerExpectedStatuses(ct)) {
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

  return findings;
}

function readDeclaredContract(
  summary: BehavioralSummary,
): DeclaredContract | null {
  const raw = summary.metadata?.declaredContract;
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const responses = (raw as { responses?: unknown }).responses;
  if (!Array.isArray(responses)) {
    return null;
  }
  const validated: Array<{ statusCode: number }> = [];
  for (const r of responses) {
    if (
      r &&
      typeof r === "object" &&
      typeof (r as { statusCode?: unknown }).statusCode === "number"
    ) {
      validated.push({ statusCode: (r as { statusCode: number }).statusCode });
    }
  }
  return { responses: validated };
}

function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}
