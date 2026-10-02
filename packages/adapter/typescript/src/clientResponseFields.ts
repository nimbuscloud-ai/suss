/**
 * What a client summary says about the responses its client hands back:
 * which properties give the body, the status and the success flag, and
 * whether a refused request or a redirect reaches the caller.
 *
 * A client call takes these from its pack. A caller of a wrapper around
 * the client takes the part of them the wrapper leaves alone. Both go
 * through the raw summary, so the extractor writes them into
 * `metadata.http` the same way.
 */

import {
  isCatchEntry,
  readHttpMetadata,
  statusMembersOf,
  testsStatus,
} from "@suss/behavioral-ir";

import { parseConditionExpression } from "./predicates.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type {
  KeepsArms,
  PatternPack,
  RawCodeStructure,
  ResponsePropertyMapping,
} from "@suss/extractor";
import type { Expression } from "ts-morph";

export type ClientResponseFields = Pick<
  RawCodeStructure,
  | "bodyAccessors"
  | "statusAccessors"
  | "successAccessors"
  | "failureDelivery"
  | "redirectDelivery"
>;

/**
 * The response properties grouped the way the checker asks for them. A
 * kind the pack declares nothing for is left out, so the checker never
 * reads an empty list as "this pack has no accessors" when it means
 * "this pack did not say".
 */
const ACCESSOR_FIELD_SEMANTICS = {
  bodyAccessors: "body",
  statusAccessors: "statusCode",
  successAccessors: "statusRange",
} as const satisfies Record<
  string,
  ResponsePropertyMapping["semantics"]["type"]
>;

/** What a client call made through this pack says about its responses. */
export function clientResponseFieldsOfPack(
  pack: PatternPack,
): ClientResponseFields {
  const out: ClientResponseFields = {};
  for (const [field, kind] of Object.entries(ACCESSOR_FIELD_SEMANTICS)) {
    const names = pack.responseSemantics
      ?.filter((m) => m.semantics.type === kind)
      .map((m) => m.name);
    if (names !== undefined && names.length > 0) {
      out[field as keyof typeof ACCESSOR_FIELD_SEMANTICS] = names;
    }
  }

  return {
    ...out,
    ...(pack.failureDelivery === undefined
      ? {}
      : { failureDelivery: pack.failureDelivery }),
    ...(pack.redirectDelivery === undefined
      ? {}
      : { redirectDelivery: pack.redirectDelivery }),
  };
}

/**
 * Which of a caller's tests go on as separate paths: the ones on the
 * response status or success flag. Each arm of such a test is a branch
 * on that status even when neither arm returns, so the checker sees
 * which statuses the caller handles.
 */
export function keepsStatusArms(
  fields: ClientResponseFields,
): KeepsArms<Expression> {
  const members = statusMembersOf(fields);
  return (condition) => {
    const test = parseConditionExpression(condition);
    return test !== null && testsStatus(test, members);
  };
}

/**
 * What still applies to a caller of a wrapper around the client. The
 * wrapper has already read the body, so its accessors do not carry over.
 * A redirect is followed inside the client either way. A failure reaches
 * the caller the same way only when the wrapper does not catch it.
 */
export function clientResponseFieldsThroughWrapper(
  wrapper: BehavioralSummary,
): ClientResponseFields {
  const http = readHttpMetadata(wrapper);
  const catches = wrapper.transitions.some((t) =>
    t.conditions.some(isCatchEntry),
  );
  return {
    ...(http?.failureDelivery === undefined || catches
      ? {}
      : { failureDelivery: http.failureDelivery }),
    ...(http?.redirectDelivery === undefined
      ? {}
      : { redirectDelivery: http.redirectDelivery }),
  };
}
