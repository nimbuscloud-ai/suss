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
  DEFAULT_SUCCESS_ACCESSORS,
  isCatchEntry,
  readHttpMetadata,
  refEndsInMember,
  statusMembersOf,
  testsStatus,
} from "@suss/behavioral-ir";
import { MAX_HELPER_PATHS } from "@suss/extractor";

import { parseConditionExpression } from "./predicates.js";

import type {
  BehavioralSummary,
  Predicate,
  Transition,
  ValueRef,
} from "@suss/behavioral-ir";
import type {
  KeepsArms,
  PatternPack,
  RawBranch,
  RawCodeStructure,
  RawTerminal,
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
 * the caller the same way only when the wrapper does not catch it, and a
 * wrapper that throws on every failure hands each one to its caller as an
 * exception, whatever its client does.
 */
export function clientResponseFieldsThroughWrapper(
  wrapper: BehavioralSummary,
): ClientResponseFields {
  const http = readHttpMetadata(wrapper);
  const catches = wrapper.transitions.some((t) =>
    t.conditions.some(isCatchEntry),
  );
  const failureDelivery = throwsEveryFailure(wrapper)
    ? "exception"
    : http?.failureDelivery;
  return {
    ...(failureDelivery === undefined || catches ? {} : { failureDelivery }),
    ...(http?.redirectDelivery === undefined
      ? {}
      : { redirectDelivery: http.redirectDelivery }),
  };
}

/**
 * The wrapper's paths as a caller of it takes them, for a wrapper that
 * tests the status: `if (!res.ok) throw ...` becomes a throw on the
 * caller's own path. Null for a wrapper that never tests it.
 */
export function wrapperStatusPaths(
  wrapper: BehavioralSummary,
): RawBranch[] | null {
  const members = statusMembersOf(readHttpMetadata(wrapper) ?? {});
  const testsTheStatus = wrapper.transitions.some((t) =>
    t.conditions.some((p) => testsStatus(p, members)),
  );
  if (!testsTheStatus || wrapper.transitions.length > MAX_HELPER_PATHS) {
    return null;
  }
  return wrapper.transitions.map((transition) => ({
    conditions: transition.conditions.map((structured) => ({
      sourceText: JSON.stringify(structured),
      structured,
      polarity: "positive",
      source: "explicit",
    })),
    terminal: wrapperTerminal(transition),
    effects: [],
    location: transition.location,
    isDefault: transition.isDefault,
  }));
}

function wrapperTerminal(transition: Transition): RawTerminal {
  const output = transition.output;
  return {
    kind: output.type === "throw" ? "throw" : "return",
    statusCode: null,
    body: null,
    exceptionType: output.type === "throw" ? output.exceptionType : null,
    message: output.type === "throw" ? output.message : null,
    component: null,
    renderTree: null,
    delegateTarget: null,
    emitEvent: null,
    location: transition.location,
  };
}

/**
 * Whether the wrapper throws on a failure status and every path that
 * does not throw is gated on a success. A path the reading cannot tie to
 * a success counts against it, so the answer is no when in doubt.
 */
function throwsEveryFailure(wrapper: BehavioralSummary): boolean {
  const http = readHttpMetadata(wrapper) ?? {};
  const members = statusMembersOf(http);
  const flags = new Set(
    http.successAccessors !== undefined && http.successAccessors.length > 0
      ? http.successAccessors
      : DEFAULT_SUCCESS_ACCESSORS,
  );
  const throws = wrapper.transitions.filter((t) => t.output.type === "throw");
  return (
    throws.some((t) => t.conditions.some((p) => testsStatus(p, members))) &&
    wrapper.transitions.every(
      (t) =>
        t.output.type === "throw" ||
        t.conditions.some((p) => admitsOnlySuccess(p, members, flags)),
    )
  );
}

/** Whether a condition is true only for a 2xx status, as `res.ok` or `status === 200` are. */
function admitsOnlySuccess(
  p: Predicate,
  members: ReadonlySet<string>,
  flags: ReadonlySet<string>,
): boolean {
  if (p.type === "negation" && p.operand.type === "negation") {
    return admitsOnlySuccess(p.operand.operand, members, flags);
  }
  if (p.type === "truthinessCheck") {
    return !p.negated && refEndsInMember(p.subject, flags);
  }
  if (p.type === "comparison") {
    return (
      p.op === "eq" &&
      refEndsInMember(p.left, members) &&
      isSuccessLiteral(p.right, 200, 299)
    );
  }
  if (p.type === "compound" && p.op === "and") {
    const bounds = p.operands.filter(
      (o): o is Extract<Predicate, { type: "comparison" }> =>
        o.type === "comparison" && refEndsInMember(o.left, members),
    );
    return (
      bounds.some(
        (b) => b.op === "gte" && isSuccessLiteral(b.right, 200, 299),
      ) &&
      bounds.some((b) => b.op === "lte" && isSuccessLiteral(b.right, 200, 299))
    );
  }
  return false;
}

function isSuccessLiteral(ref: ValueRef, min: number, max: number): boolean {
  return (
    ref.type === "literal" &&
    typeof ref.value === "number" &&
    ref.value >= min &&
    ref.value <= max
  );
}
