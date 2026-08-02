import { statusAccessorsFor } from "../contract/declaredContract.js";
import {
  consumerExpectedStatuses,
  extractResponseStatus,
  hasOpaqueStatus,
  makeBoundary,
  makeSide,
} from "../coverage/responseMatch.js";

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
    const status = extractResponseStatus(pt);
    if (status !== null) {
      providerStatuses.add(status);
    } else if (hasOpaqueStatus(pt)) {
      providerHasOpaqueStatus = true;
    }
  }

  const statusAccessors = statusAccessorsFor(consumer);

  for (const ct of consumer.transitions) {
    const expected = consumerExpectedStatuses(ct, statusAccessors);
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
          description: `Consumer expects status ${status}, and one of the provider's statuses could not be read, so this cannot be confirmed either way`,
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
