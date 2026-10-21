import { statusAccessorsFor } from "../contract/declaredContract.js";
import { lowestStatusSentUnread } from "../contract/partlyRead.js";
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

import type {
  BehavioralSummary,
  Finding,
  WrapperIndex,
} from "@suss/behavioral-ir";
import type { DeclaredStatusRange } from "../coverage/responseMatch.js";

/** No summaries to look a wrapper up in, so every wrapper counts as unread. */
const NO_WRAPPER_SUMMARIES: WrapperIndex = new Map();

export function checkConsumerSatisfaction(
  provider: BehavioralSummary,
  consumer: BehavioralSummary,
  wrappers: WrapperIndex = NO_WRAPPER_SUMMARIES,
): Finding[] {
  const findings: Finding[] = [];
  const boundary = makeBoundary(provider, consumer);

  // When suss read nothing of the provider it has no statuses, and
  // calling the consumer's branches dead would blame the consumer for
  // that. Those branches get low confidence instead.
  const unread = nothingWasRead(provider);
  // A wrapper suss did not read, or a throw the framework turns into a
  // status, can send a status no transition shows.
  const unreadFrom = lowestStatusSentUnread(provider, wrappers);

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
      if (providerHasOpaqueStatus || unread || status >= unreadFrom) {
        findings.push({
          kind: "lowConfidence",
          boundary,
          provider: makeSide(provider),
          consumer: makeSide(consumer, ct.id),
          description: `Consumer expects status ${status}, and ${whatWentUnread(unread, providerHasOpaqueStatus)}, so this cannot be confirmed either way`,
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

/** Why the provider's statuses are not all known, as the finding says it. */
function whatWentUnread(nothingRead: boolean, opaqueStatus: boolean): string {
  if (nothingRead) {
    return "nothing about what the provider answers was read";
  }
  if (opaqueStatus) {
    return "one of the provider's statuses could not be read";
  }
  return "part of the provider went unread, such as a wrapper around it";
}
