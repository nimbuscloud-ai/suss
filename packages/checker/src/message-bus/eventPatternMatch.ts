/**
 * Whether an EventBridge send reaches a rule, judged by the rule's
 * pattern rather than by its channel string.
 *
 * A rule matches an event when the bus agrees and each field the
 * pattern filters on agrees. A send states its detail-type in its
 * channel and its source as the routing key, and either can be missing.
 * A field the send leaves unknown, or one the pattern filters in a way
 * suss does not read, can only possibly match. A possible match keeps
 * an orphan finding away, and nothing is compared across it.
 */

import { busesAgree, parseChannel } from "@suss/ir-core";

import type { MessageBusMetadata } from "@suss/behavioral-ir";

export type EventPattern = NonNullable<MessageBusMetadata["eventPattern"]>;

export type PatternMatch = "certain" | "possible";

/** What one send says about the event it puts on the bus. */
export interface SentEvent {
  bus: string | null;
  detailType: string | null;
  source: string | null;
}

/** The bus and detail-type of a send's channel, and the source it states. */
export function sentEventOf(
  channel: string,
  routingKey: string | undefined,
): SentEvent {
  const { bus, subject } = parseChannel(channel);
  return {
    bus,
    detailType: subject === "" ? null : subject,
    source: routingKey ?? null,
  };
}

/** Null when the send cannot reach a rule with this pattern on this bus. */
export function patternMatch(
  pattern: EventPattern,
  ruleBus: string | null,
  sent: SentEvent,
): PatternMatch | null {
  if (!busesAgree(ruleBus, sent.bus)) {
    return null;
  }
  const unsettled = new Set(pattern.unsettled ?? []);
  const fields = [
    fieldMatch(
      pattern.detailTypes,
      unsettled.has("detail-type"),
      sent.detailType,
    ),
    fieldMatch(pattern.sources, unsettled.has("source"), sent.source),
  ];
  if (fields.includes(null)) {
    return null;
  }
  if (fields.includes("possible")) {
    return "possible";
  }

  return "certain";
}

function fieldMatch(
  values: string[] | undefined,
  unsettled: boolean,
  sent: string | null,
): PatternMatch | null {
  if (unsettled) {
    return "possible";
  }
  if (values === undefined) {
    return "certain";
  }
  if (sent === null) {
    return "possible";
  }

  return values.includes(sent) ? "certain" : null;
}
