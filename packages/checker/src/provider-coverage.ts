import {
  consumerExpectedStatuses,
  extractResponseStatus,
  hasOpaqueStatus,
  makeBoundary,
  makeSide,
} from "./response-match.js";

import type { BehavioralSummary, Finding } from "@suss/behavioral-ir";

export function checkProviderCoverage(
  provider: BehavioralSummary,
  consumer: BehavioralSummary,
): Finding[] {
  const findings: Finding[] = [];
  const boundary = makeBoundary(provider, consumer);

  const consumerStatuses = new Set<number>();
  let consumerHasDefault = false;
  for (const ct of consumer.transitions) {
    if (ct.isDefault) {
      consumerHasDefault = true;
    }
    for (const s of consumerExpectedStatuses(ct)) {
      consumerStatuses.add(s);
    }
  }

  for (const pt of provider.transitions) {
    if (hasOpaqueStatus(pt)) {
      findings.push({
        kind: "lowConfidence",
        boundary,
        provider: makeSide(provider, pt.id),
        consumer: makeSide(consumer),
        description: `Provider transition ${pt.id} has an opaque status code; coverage cannot be verified`,
        severity: "info",
      });
      continue;
    }

    const status = extractResponseStatus(pt);
    if (status == null) {
      continue;
    }

    if (consumerStatuses.has(status)) {
      continue;
    }
    if (consumerHasDefault && isSuccessStatus(status)) {
      continue;
    }

    findings.push({
      kind: "unhandledProviderCase",
      boundary,
      provider: makeSide(provider, pt.id),
      consumer: makeSide(consumer),
      description: `Provider produces status ${status} but no consumer branch handles it`,
      severity: "error",
    });
  }

  return findings;
}

function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}
