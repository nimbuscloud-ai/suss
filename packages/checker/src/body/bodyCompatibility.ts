/**
 * Compares response bodies across a boundary. For each consumer branch
 * that reads fields off the body, the provider responses with the same
 * status are checked for every field the consumer reads.
 */

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

/**
 * Whether `provider` has every field that `consumer` reads.
 *
 * `bodyShapesMatch` compares types, and this compares field presence.
 * Consumer leaves are usually `{ type: "unknown" }`, since the IR
 * records which fields a consumer read and not what types it expected,
 * so an unknown leaf counts as present.
 *
 * Returns "match" when every field the consumer reads exists in the
 * provider, "nomatch" when one does not, and "unknown" when the
 * provider shape is opaque (a ref or an unknown) or has a spread that
 * could supply the field.
 */
export function providerCoversConsumerFields(
  provider: TypeShape,
  consumer: TypeShape,
): MatchResult {
  if (consumer.type === "unknown") {
    return "match";
  }

  if (provider.type === "unknown" || provider.type === "ref") {
    return "unknown";
  }

  // An optional field (`union<T, undefined>`) still exists, so compare
  // against the defined variant. findOptionalAccesses reports the
  // optionality as its own info finding.
  if (isOptionalShape(provider)) {
    return providerCoversConsumerFields(unwrapOptional(provider), consumer);
  }

  if (consumer.type === "record" && provider.type === "record") {
    let result: MatchResult = "match";
    for (const key of Object.keys(consumer.properties)) {
      const providerProp = provider.properties[key];
      if (providerProp === undefined) {
        // A spread could supply the field.
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

  // A dictionary can have any key.
  if (consumer.type === "record" && provider.type === "dictionary") {
    return "match";
  }

  if (consumer.type === "record") {
    return "nomatch";
  }

  // Field tracking records consumer reads as a record, so this is not expected.
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
 * The paths where the consumer reads a field the provider declares as
 * optional (`union<T, undefined>`).
 *
 * Field presence still matches for these, but the consumer depends on a
 * value the provider may leave out.
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

/**
 * The consumer's expected shape with `drop` taken off the top level.
 * Two kinds of field are dropped: a field the provider returns only on
 * a failure, which tells the consumer which case came back, and the
 * accessor the client reads the body through, which belongs to the
 * response object and not the body.
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
 * The label a finding uses for a success response ("200", or "2XX" for
 * a declared range), or null when the transition is not a success
 * response.
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

        // checkResponseMisread reports a read of a field the body lacks, so
        // this check reports only what it could not compare.
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
