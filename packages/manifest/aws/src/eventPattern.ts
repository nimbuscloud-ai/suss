/**
 * Reads what an EventBridge rule says about the events it matches, and
 * which bus those events arrive on.
 *
 * A rule's EventPattern and its EventBusName are written the same way in a
 * CloudFormation template and in a serverless.yml eventBridge event, so
 * both readers reduce them here.
 */

import { refTarget } from "./templateLoader.js";

/** A pattern field that is not a plain list of strings. */
export type UnsettledPatternField = "detail-type" | "source";

/**
 * What a rule's EventPattern says about the two fields a send states.
 * A field the pattern leaves out matches every value, so it has no
 * entry here. A field written as anything but a list of strings, such
 * as a prefix filter, is listed in `unsettled`.
 */
export interface EventPatternFields {
  detailTypes?: string[];
  sources?: string[];
  unsettled: UnsettledPatternField[];
  /**
   * A source starts with `aws.`. Only AWS services send those, and
   * PutEvents refuses them from anyone else.
   */
  emittedByAws: boolean;
}

/** Null when the rule declares no EventPattern at all. */
export function readEventPattern(pattern: unknown): EventPatternFields | null {
  if (pattern === null || typeof pattern !== "object") {
    return null;
  }
  const record = pattern as Record<string, unknown>;
  const detailTypes = literalValues(record["detail-type"]);
  const sources = literalValues(record.source);
  const unsettled: UnsettledPatternField[] = [
    ...(detailTypes === "unsettled" ? ["detail-type" as const] : []),
    ...(sources === "unsettled" ? ["source" as const] : []),
  ];
  return {
    ...(Array.isArray(detailTypes) ? { detailTypes } : {}),
    ...(Array.isArray(sources) ? { sources } : {}),
    unsettled,
    emittedByAws:
      Array.isArray(sources) &&
      sources.some((source) => source.startsWith("aws.")),
  };
}

/** Null when the field is left out, so every value matches it. */
function literalValues(value: unknown): string[] | null | "unsettled" {
  if (value === undefined) {
    return null;
  }
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((entry) => typeof entry === "string")
  ) {
    return "unsettled";
  }

  return value;
}

/**
 * Resolve a rule's EventBusName to the channel's bus token: the CFN
 * logical id when it's a Ref/GetAtt, the name segment of an event-bus
 * ARN, the literal string otherwise, or "default" when it's left out
 * (the EventBridge default event bus).
 */
export function resolveEventBusToken(value: unknown): string {
  if (value === null || value === undefined) {
    return "default";
  }
  if (typeof value === "object") {
    const logicalId = refTarget(value);
    // Prefer the logical id even when the referenced resource isn't in
    // this template, because the producer side collapses its own chain
    // of references down to the same id.
    return logicalId ?? "default";
  }
  if (typeof value === "string") {
    const arnMatch = value.match(/:event-bus\/(.+)$/);
    if (arnMatch !== null) {
      return arnMatch[1];
    }

    return value;
  }
  return "default";
}
