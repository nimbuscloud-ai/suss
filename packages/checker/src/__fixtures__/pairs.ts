import {
  CATCH_ENTRY_TEXT,
  functionCallBinding,
  readHttpMetadata,
  withHttpMetadata,
} from "@suss/behavioral-ir";

import type {
  BehavioralSummary,
  Gap,
  Output,
  Predicate,
  Transition,
  TypeShape,
  ValueRef,
} from "@suss/behavioral-ir";

const responseValueRef: ValueRef = {
  type: "dependency",
  name: "fetch",
  accessChain: [],
};

const responseStatusRef: ValueRef = {
  type: "derived",
  from: responseValueRef,
  derivation: { type: "propertyAccess", property: "status" },
};

export function statusEq(status: number): Predicate {
  return {
    type: "comparison",
    left: responseStatusRef,
    op: "eq",
    right: { type: "literal", value: status },
  };
}

/** What the adapter rewrites `res.ok` into: `status >= min && status <= max`. */
export function statusInRange(min: number, max: number): Predicate {
  return {
    type: "compound",
    op: "and",
    operands: [
      {
        type: "comparison",
        left: responseStatusRef,
        op: "gte",
        right: { type: "literal", value: min },
      },
      {
        type: "comparison",
        left: responseStatusRef,
        op: "lte",
        right: { type: "literal", value: max },
      },
    ],
  };
}

export function negated(operand: Predicate): Predicate {
  return { type: "negation", operand };
}

/** `res.ok` left as written, which is how a hand-written summary spells it. */
export function successFlag(isNegated: boolean): Predicate {
  return {
    type: "truthinessCheck",
    subject: {
      type: "derived",
      from: responseValueRef,
      derivation: { type: "propertyAccess", property: "ok" },
    },
    negated: isNegated,
  };
}

/** `res.error`, the guard a consumer writes to read the failure body. */
export function bodyFieldTruthy(field: string): Predicate {
  return {
    type: "truthinessCheck",
    subject: {
      type: "derived",
      from: responseValueRef,
      derivation: { type: "propertyAccess", property: field },
    },
    negated: false,
  };
}

/** What the path engine writes on a branch reached by an exception. */
export function catchEntry(): Predicate {
  return {
    type: "opaque",
    sourceText: CATCH_ENTRY_TEXT,
    reason: "complexExpression",
  };
}

/** A JSON body with these top-level fields and nothing said about their types. */
export function recordBody(...fields: string[]): TypeShape {
  return {
    type: "record",
    properties: Object.fromEntries(
      fields.map((field) => [field, { type: "unknown" } as TypeShape]),
    ),
  };
}

/** A consumer whose client rejects on a non-2xx, the way axios does. */
export function throwsOnFailure(summary: BehavioralSummary): BehavioralSummary {
  return {
    ...summary,
    metadata: withHttpMetadata(summary.metadata, {
      ...readHttpMetadata(summary),
      failureDelivery: "exception",
    }),
  };
}

export function response(
  status: number,
  body: TypeShape | null = null,
): Output {
  return {
    type: "response",
    statusCode: { type: "literal", value: status },
    body,
    headers: {},
  };
}

export function opaqueResponse(): Output {
  return {
    type: "response",
    statusCode: { type: "unresolved", sourceText: "statusVar" },
    body: null,
    headers: {},
  };
}

/**
 * A response with no status literal: what a contract reader emits for a
 * range code (pass `range` on the transition) or for a catch-all
 * `default` (mark the transition `isDefault`).
 */
export function rangeResponse(body: TypeShape | null = null): Output {
  return { type: "response", statusCode: null, body, headers: {} };
}

export function transition(
  id: string,
  opts: {
    conditions?: Predicate[];
    output: Output;
    isDefault?: boolean;
    range?: { min: number; max: number; spec: string };
  },
): Transition {
  return {
    id,
    conditions: opts.conditions ?? [],
    output: opts.output,
    effects: [],
    location: { start: 1, end: 10 },
    isDefault: opts.isDefault ?? false,
    ...(opts.range !== undefined
      ? { metadata: withHttpMetadata(undefined, { statusRange: opts.range }) }
      : {}),
  };
}

export function provider(
  name: string,
  transitions: Transition[],
  opts?: { framework?: string },
): BehavioralSummary {
  return {
    kind: "handler",
    location: {
      file: `src/handlers/${name}.ts`,
      range: { start: 1, end: 50 },
      exportName: name,
    },
    identity: {
      name,
      exportPath: [name],
      // No REST routing on the fixture: tests that need one use
      // `providerWithPath` which overrides the binding. Function-call
      // semantics keep the binding valid under the new schema without
      // pretending a method/path were extracted.
      boundaryBinding: functionCallBinding({
        transport: "http",
        recognition: opts?.framework ?? "ts-rest",
      }),
    },
    inputs: [],
    transitions,
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

export function withContract(
  summary: BehavioralSummary,
  declaredStatuses: number[],
  gaps: Gap[] = [],
): BehavioralSummary {
  return {
    ...summary,
    gaps,
    metadata: withHttpMetadata(summary.metadata, {
      ...readHttpMetadata(summary),
      declaredContract: {
        framework: "ts-rest",
        provenance: "independent",
        responses: declaredStatuses.map((statusCode) => ({ statusCode })),
      },
    }),
  };
}

export function withContractBodies(
  summary: BehavioralSummary,
  responses: Array<{ statusCode: number; body: TypeShape | null }>,
  gaps: Gap[] = [],
): BehavioralSummary {
  return {
    ...summary,
    gaps,
    metadata: withHttpMetadata(summary.metadata, {
      ...readHttpMetadata(summary),
      declaredContract: {
        framework: "ts-rest",
        provenance: "independent",
        responses,
      },
    }),
  };
}

/** A contract with any mix of literal, range, and default responses. */
export function withRangeContract(
  summary: BehavioralSummary,
  contract: {
    responses?: Array<{ statusCode: number; body?: TypeShape | null }>;
    responseRanges?: Array<{
      min: number;
      max: number;
      spec: string;
      body?: TypeShape | null;
    }>;
    defaultResponse?: { body?: TypeShape | null };
  },
): BehavioralSummary {
  return {
    ...summary,
    metadata: withHttpMetadata(summary.metadata, {
      ...readHttpMetadata(summary),
      declaredContract: {
        framework: "openapi",
        provenance: "independent",
        responses: contract.responses ?? [],
        ...(contract.responseRanges !== undefined
          ? { responseRanges: contract.responseRanges }
          : {}),
        ...(contract.defaultResponse !== undefined
          ? { defaultResponse: contract.defaultResponse }
          : {}),
      },
    }),
  };
}

export function unhandledCaseGap(description: string): Gap {
  return {
    type: "unhandledCase",
    conditions: [],
    consequence: "frameworkDefault",
    description,
  };
}

/** A gap saying part of the unit went undescribed, rather than that it
 * misbehaved. */
export function unreadOutcomeGap(description: string): Gap {
  return {
    type: "unreadOutcome",
    conditions: [],
    consequence: "unknown",
    description,
  };
}

export function consumer(
  name: string,
  transitions: Transition[],
  metadata?: BehavioralSummary["metadata"],
): BehavioralSummary {
  return {
    kind: "client",
    location: {
      file: `src/ui/${name}.ts`,
      range: { start: 1, end: 30 },
      exportName: name,
    },
    identity: {
      name,
      exportPath: [name],
      boundaryBinding: functionCallBinding({
        transport: "http",
        recognition: "fetch",
      }),
    },
    inputs: [],
    transitions,
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
    ...(metadata !== undefined ? { metadata } : {}),
  };
}
