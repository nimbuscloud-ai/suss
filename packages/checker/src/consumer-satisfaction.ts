import {
  consumerExpectedStatuses,
  makeBoundary,
  makeSide,
} from "./response-match.js";

import type { BehavioralSummary, Finding } from "@suss/behavioral-ir";

export function checkConsumerSatisfaction(
  provider: BehavioralSummary,
  consumer: BehavioralSummary,
): Finding[] {
  const findings: Finding[] = [];
  const boundary = makeBoundary(provider, consumer);

  const providerStatuses = new Set<number>();
  let providerHasOpaqueStatus = false;
  for (const pt of provider.transitions) {
    if (pt.output.type !== "response") {
      continue;
    }
    const sc = pt.output.statusCode;
    if (sc?.type === "literal" && typeof sc.value === "number") {
      providerStatuses.add(sc.value);
    } else if (sc != null && sc.type !== "literal") {
      providerHasOpaqueStatus = true;
    }
  }

  for (const ct of consumer.transitions) {
    const expected = consumerExpectedStatuses(ct);
    for (const status of expected) {
      if (providerStatuses.has(status)) {
        continue;
      }
      if (providerHasOpaqueStatus) {
        findings.push({
          kind: "lowConfidence",
          boundary,
          provider: makeSide(provider),
          consumer: makeSide(consumer, ct.id),
          description: `Consumer expects status ${status}; provider has an opaque status code so satisfaction cannot be verified`,
          severity: "info",
        });
        continue;
      }
      findings.push({
        kind: "deadConsumerBranch",
        boundary,
        provider: makeSide(provider),
        consumer: makeSide(consumer, ct.id),
        description: `Consumer expects status ${status} but provider never produces it`,
        severity: "warning",
      });
    }
  }

  return findings;
}
