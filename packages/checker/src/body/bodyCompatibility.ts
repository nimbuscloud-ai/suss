// body-compatibility.ts: Cross-boundary body shape comparison
//
// For each consumer transition that has expectedInput (fields the consumer
// reads from the response body), find the matching provider transition(s)
// by status code and compare the provider's output body against the
// consumer's expected shape.

import {
  bodyAccessorsFor,
  statusAccessorsFor,
  unwrapBodyField,
} from "../contract/declaredContract.js";
import { failureOnlyBodyFields } from "../coverage/contentDiscrimination.js";
import {
  consumerExpectedStatuses,
  extractResponseStatus,
  extractResponseStatusRange,
  isSuccessStatus,
  makeBoundary,
  makeSide,
} from "../coverage/responseMatch.js";

import type {
  BehavioralSummary,
  Finding,
  Transition,
  TypeShape,
} from "@suss/behavioral-ir";
import type { MatchResult } from "../match.js";

// ---------------------------------------------------------------------------
// Field-presence comparison
// ---------------------------------------------------------------------------

/**
 * Check whether `provider` contains all fields that `consumer` expects.
 *
 * This is NOT the same as `bodyShapesMatch`: that function checks type
 * compatibility (is `actual` assignable to `declared`). This function checks
 * **field presence**: does the provider's record have every key the consumer
 * reads?
 *
 * Consumer leaves are typically `{ type: "unknown" }` because we only tracked
 * which fields were accessed, not what types the consumer expects. Unknown
 * leaves are treated as "field exists, type not checked" → match.
 *
 * Returns:
 *   - "match" when every field the consumer reads exists in the provider
 *   - "nomatch" when the consumer reads a field the provider doesn't have
 *   - "unknown" when the provider shape is opaque (a ref or an unknown)
 */
export function providerCoversConsumerFields(
  provider: TypeShape,
  consumer: TypeShape,
): MatchResult {
  if (consumer.type === "unknown") {
    return "match";
  }

  // Provider is opaque: we can't tell if the fields exist
  if (provider.type === "unknown" || provider.type === "ref") {
    return "unknown";
  }

  // Optional provider field (`union<T, undefined>`): the field exists at the
  // type level, so unwrap and continue the field-presence comparison against
  // the non-undefined variant. The fact that it's optional is surfaced as a
  // separate info-level finding via findOptionalAccesses, not as a mismatch.
  if (isOptionalShape(provider)) {
    return providerCoversConsumerFields(unwrapOptional(provider), consumer);
  }

  if (consumer.type === "record" && provider.type === "record") {
    let result: MatchResult = "match";
    for (const key of Object.keys(consumer.properties)) {
      const providerProp = provider.properties[key];
      if (providerProp === undefined) {
        // Check spreads: if provider has spreads, we can't be sure
        if (provider.spreads && provider.spreads.length > 0) {
          result = combineResults(result, "unknown");
          continue;
        }
        return "nomatch";
      }
      const nested = providerCoversConsumerFields(
        providerProp,
        consumer.properties[key],
      );
      result = combineResults(result, nested);
    }
    return result;
  }

  // Consumer expects a record but provider is a dictionary: all keys exist
  if (consumer.type === "record" && provider.type === "dictionary") {
    return "match";
  }

  if (consumer.type === "record") {
    return "nomatch";
  }

  // Non-record consumer shapes (shouldn't happen for field tracking, but safe)
  return "unknown";
}

function combineResults(a: MatchResult, b: MatchResult): MatchResult {
  if (a === "nomatch" || b === "nomatch") {
    return "nomatch";
  }
  if (a === "unknown" || b === "unknown") {
    return "unknown";
  }
  return "match";
}

/**
 * Walk the consumer field tree against the provider's shape and return the
 * dot-paths where the consumer reads a field the provider declares as
 * optional (modeled as `union<T, undefined>`).
 *
 * The check still passes for these (the field exists), but consumers should
 * know they're depending on a value the provider may legally omit.
 */
export function findOptionalAccesses(
  provider: TypeShape,
  consumer: TypeShape,
  prefix: string[] = [],
): string[][] {
  if (consumer.type !== "record" || provider.type !== "record") {
    return [];
  }
  const out: string[][] = [];
  for (const key of Object.keys(consumer.properties)) {
    const providerProp = provider.properties[key];
    if (providerProp === undefined) {
      continue;
    }
    if (isOptionalShape(providerProp)) {
      out.push([...prefix, key]);
    }
    const inner = unwrapOptional(providerProp);
    out.push(
      ...findOptionalAccesses(inner, consumer.properties[key], [
        ...prefix,
        key,
      ]),
    );
  }
  return out;
}

function isOptionalShape(shape: TypeShape): boolean {
  return (
    shape.type === "union" && shape.variants.some((v) => v.type === "undefined")
  );
}

function unwrapOptional(shape: TypeShape): TypeShape {
  if (!isOptionalShape(shape) || shape.type !== "union") {
    return shape;
  }
  const nonUndef = shape.variants.filter((v) => v.type !== "undefined");
  if (nonUndef.length === 1) {
    return nonUndef[0];
  }
  return { type: "union", variants: nonUndef };
}

// ---------------------------------------------------------------------------
// Main check
// ---------------------------------------------------------------------------

/**
 * The consumer's expected shape with `drop` taken off the top level.
 * Two kinds of name go: a field the provider returns only when it
 * refuses, which says which case came back, and the accessor the client
 * reaches the body through, which is a method on the response rather
 * than anything the body includes.
 */
function withoutFields(shape: TypeShape, drop: ReadonlySet<string>): TypeShape {
  if (shape.type !== "record" || drop.size === 0) {
    return shape;
  }
  const properties = Object.fromEntries(
    Object.entries(shape.properties).filter(([key]) => !drop.has(key)),
  );
  return { ...shape, properties };
}

/**
 * How to say which success response a provider transition is in a
 * finding ("200", or "2XX" for one declared as a range), or null when
 * the transition is not a success response.
 */
function successResponseLabel(pt: Transition): string | null {
  const status = extractResponseStatus(pt);
  if (status !== null) {
    return isSuccessStatus(status) ? String(status) : null;
  }
  const range = extractResponseStatusRange(pt);
  if (range !== null && range.min >= 200 && range.max < 300) {
    return range.spec;
  }
  return null;
}

export function checkBodyCompatibility(
  provider: BehavioralSummary,
  consumer: BehavioralSummary,
): Finding[] {
  const findings: Finding[] = [];
  const boundary = makeBoundary(provider, consumer);
  const statusAccessors = statusAccessorsFor(consumer);
  const notAClaimAbout200 = new Set([
    ...failureOnlyBodyFields(provider).flatMap((entry) => [...entry.fields]),
    ...bodyAccessorsFor(consumer),
  ]);

  for (const ct of consumer.transitions) {
    const expectedInput = ct.expectedInput;
    if (expectedInput === undefined || expectedInput === null) {
      continue;
    }

    const consumerStatuses = consumerExpectedStatuses(ct, statusAccessors);

    for (const status of consumerStatuses) {
      // A range transition ("4XX") is the declared response for every
      // member, so a branch on 404 is compared against its body.
      const matchingProviderTransitions = provider.transitions.filter((pt) => {
        const providerStatus = extractResponseStatus(pt);
        if (providerStatus !== null) {
          return providerStatus === status;
        }
        const range = extractResponseStatusRange(pt);
        return range !== null && status >= range.min && status <= range.max;
      });

      for (const pt of matchingProviderTransitions) {
        if (pt.output.type !== "response") {
          continue;
        }
        const providerBody = pt.output.body;
        if (providerBody === null) {
          continue;
        }

        const consumerBodyShape = unwrapBodyField(expectedInput, consumer);

        const result = providerCoversConsumerFields(
          providerBody,
          consumerBodyShape,
        );

        // A read of a field the body provably lacks is checkResponseMisread's
        // finding; this check reports only what it could not compare.
        if (result === "unknown") {
          findings.push({
            kind: "lowConfidence",
            boundary,
            provider: makeSide(provider, pt.id),
            consumer: makeSide(consumer, ct.id),
            description: `The provider's body on status ${status} could not be fully compared with what the consumer reads`,
            severity: "info",
          });
        }

        for (const path of findOptionalAccesses(
          providerBody,
          consumerBodyShape,
        )) {
          findings.push({
            kind: "consumerContractViolation",
            boundary,
            provider: makeSide(provider, pt.id),
            consumer: makeSide(consumer, ct.id),
            description: `Consumer reads "${path.join(".")}" on status ${status}, but the provider declares it optional`,
            severity: "info",
          });
        }
      }
    }

    if (consumerStatuses.length === 0 && ct.isDefault) {
      for (const pt of provider.transitions) {
        const successLabel = successResponseLabel(pt);
        if (successLabel === null) {
          continue;
        }
        if (pt.output.type !== "response" || pt.output.body === null) {
          continue;
        }
        const consumerBodyShape = withoutFields(
          unwrapBodyField(expectedInput, consumer),
          notAClaimAbout200,
        );
        for (const path of findOptionalAccesses(
          pt.output.body,
          consumerBodyShape,
        )) {
          findings.push({
            kind: "consumerContractViolation",
            boundary,
            provider: makeSide(provider, pt.id),
            consumer: makeSide(consumer, ct.id),
            description: `Consumer reads "${path.join(".")}" on default branch (status ${successLabel}), but the provider declares it optional`,
            severity: "info",
          });
        }
      }
    }
  }

  return findings;
}
