import { bodyShapesMatch } from "./body-match.js";
import {
  consumerExpectedStatuses,
  extractResponseStatus,
  makeBoundary,
  makeSide,
} from "./response-match.js";

import type {
  BehavioralSummary,
  Finding,
  TypeShape,
} from "@suss/behavioral-ir";

interface DeclaredContract {
  responses: Array<{ statusCode: number; body: TypeShape | null }>;
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
  const validated: Array<{ statusCode: number; body: TypeShape | null }> = [];
  for (const r of responses) {
    if (
      r &&
      typeof r === "object" &&
      typeof (r as { statusCode?: unknown }).statusCode === "number"
    ) {
      const bodyRaw = (r as { body?: unknown }).body;
      const body =
        bodyRaw && typeof bodyRaw === "object" ? (bodyRaw as TypeShape) : null;
      validated.push({
        statusCode: (r as { statusCode: number }).statusCode,
        body,
      });
    }
  }
  return { responses: validated };
}

function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}
