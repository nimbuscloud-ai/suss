import { statusAccessorsFor } from "../contract/declaredContract.js";
import {
  consumerExpectedStatuses,
  extractResponseStatus,
  hasOpaqueStatus,
  makeBoundary,
  makeSide,
  nothingWasRead,
} from "../coverage/responseMatch.js";

import type { BehavioralSummary, Finding } from "@suss/behavioral-ir";

export function checkConsumerSatisfaction(
  provider: BehavioralSummary,
  consumer: BehavioralSummary,
): Finding[] {
  const findings: Finding[] = [];
  const boundary = makeBoundary(provider, consumer);

  // A provider nobody could read produces no status, and calling the
  // consumer's branches dead on that basis blames the consumer for a
  // limit on the reading. Same treatment as a status that came back
  // opaque: say it cannot be confirmed, and leave the warning for a
  // provider that was read.
  const unread = nothingWasRead(provider);

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
      if (providerHasOpaqueStatus || unread) {
        findings.push({
          kind: "lowConfidence",
          boundary,
          provider: makeSide(provider),
          consumer: makeSide(consumer, ct.id),
          description: unread
            ? `Consumer expects status ${status}, and nothing about what the provider answers was read, so this cannot be confirmed either way`
            : `Consumer expects status ${status}, and one of the provider's statuses could not be read, so this cannot be confirmed either way`,
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
