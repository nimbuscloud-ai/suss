import { statusAccessorsFor } from "../contract/declaredContract.js";
import {
  consumerExpectedStatuses,
  extractResponseStatus,
  extractResponseStatusRange,
  hasOpaqueStatus,
  isCatchAllResponse,
  makeBoundary,
  makeSide,
  nothingWasRead,
} from "../coverage/responseMatch.js";

import type { BehavioralSummary, Finding } from "@suss/behavioral-ir";
import type { DeclaredStatusRange } from "../coverage/responseMatch.js";

export function checkConsumerSatisfaction(
  provider: BehavioralSummary,
  consumer: BehavioralSummary,
): Finding[] {
  const findings: Finding[] = [];
  const boundary = makeBoundary(provider, consumer);

  // A provider nobody could read produces no status, so calling the
  // consumer's branches dead would blame the consumer for a limit in
  // what suss could read. Say it cannot be confirmed instead.
  const unread = nothingWasRead(provider);

  const providerStatuses = new Set<number>();
  const providerRanges: DeclaredStatusRange[] = [];
  // A catch-all response covers every status the other transitions
  // leave out, so when one is present a consumer branch is never dead.
  let providerHasCatchAll = false;
  let providerHasOpaqueStatus = false;
  for (const pt of provider.transitions) {
    const status = extractResponseStatus(pt);
    if (status !== null) {
      providerStatuses.add(status);
      continue;
    }
    const range = extractResponseStatusRange(pt);
    if (range !== null) {
      providerRanges.push(range);
      continue;
    }
    if (isCatchAllResponse(pt)) {
      providerHasCatchAll = true;
      continue;
    }
    if (hasOpaqueStatus(pt)) {
      providerHasOpaqueStatus = true;
    }
  }

  const producesStatus = (status: number): boolean =>
    providerHasCatchAll ||
    providerStatuses.has(status) ||
    providerRanges.some((r) => status >= r.min && status <= r.max);

  const statusAccessors = statusAccessorsFor(consumer);

  for (const ct of consumer.transitions) {
    const expected = consumerExpectedStatuses(ct, statusAccessors);
    for (const status of expected) {
      if (producesStatus(status)) {
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
