// eventPattern.ts: read what an EventBridge rule states about the
// events it matches, and which bus carries them.
//
// A rule's EventPattern and its EventBusName are written the same way
// in a CloudFormation template and in a serverless.yml eventBridge
// event, so both readers reduce them here.

import { refTarget } from "./templateLoader.js";

/**
 * How far a rule's EventPattern reduced: to the exact detail-types it
 * lists, or not at all, with the reason a person can read back.
 */
export type PatternReduction =
  | { kind: "exact"; detailTypes: string[] }
  | { kind: "unresolvable"; reason: string };

/**
 * Reduce a rule's EventPattern to the exact set of DetailTypes it
 * matches. v0 handles only a literal `detail-type` array; anything else
 * (absent detail-type, content-filter objects, empty array) is
 * unresolvable, surfaced by the checker, never silently dropped.
 */
export function reduceEventPattern(pattern: unknown): PatternReduction {
  if (pattern === null || typeof pattern !== "object") {
    return {
      kind: "unresolvable",
      reason: "rule declares no EventPattern",
    };
  }
  const detailType = (pattern as Record<string, unknown>)["detail-type"];
  if (detailType === undefined) {
    return {
      kind: "unresolvable",
      reason:
        "EventPattern has no detail-type; v0 reduces routing to exact detail-type match only",
    };
  }
  if (!Array.isArray(detailType)) {
    return {
      kind: "unresolvable",
      reason: "detail-type is not a plain array of string literals",
    };
  }
  const detailTypes: string[] = [];
  for (const entry of detailType) {
    if (typeof entry !== "string") {
      return {
        kind: "unresolvable",
        reason:
          "detail-type contains a content filter (prefix / anything-but / etc.); pattern subsumption is out of v0 scope",
      };
    }
    detailTypes.push(entry);
  }
  if (detailTypes.length === 0) {
    return { kind: "unresolvable", reason: "detail-type array is empty" };
  }
  return { kind: "exact", detailTypes };
}

/**
 * Resolve a rule's EventBusName to the channel's bus token: the CFN
 * logical id when it's a Ref/GetAtt, the segmented name from an event-
 * bus ARN, the literal string otherwise, or "default" when omitted (the
 * EventBridge default event bus).
 */
export function resolveEventBusToken(value: unknown): string {
  if (value === null || value === undefined) {
    return "default";
  }
  if (typeof value === "object") {
    const logicalId = refTarget(value);
    // Prefer the logical id even when the referenced resource isn't in
    // this template; the producer side chain-collapses to the same id.
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
