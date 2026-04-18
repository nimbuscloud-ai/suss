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

export function transition(
  id: string,
  opts: {
    conditions?: Predicate[];
    output: Output;
    isDefault?: boolean;
  },
): Transition {
  return {
    id,
    conditions: opts.conditions ?? [],
    output: opts.output,
    effects: [],
    location: { start: 1, end: 10 },
    isDefault: opts.isDefault ?? false,
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
      boundaryBinding: {
        protocol: "http",
        framework: opts?.framework ?? "ts-rest",
      },
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
  const existingHttp =
    summary.metadata?.http && typeof summary.metadata.http === "object"
      ? (summary.metadata.http as Record<string, unknown>)
      : {};
  return {
    ...summary,
    gaps,
    metadata: {
      ...(summary.metadata ?? {}),
      http: {
        ...existingHttp,
        declaredContract: {
          framework: "ts-rest",
          responses: declaredStatuses.map((statusCode) => ({ statusCode })),
        },
      },
    },
  };
}

export function withContractBodies(
  summary: BehavioralSummary,
  responses: Array<{ statusCode: number; body: TypeShape | null }>,
  gaps: Gap[] = [],
): BehavioralSummary {
  const existingHttp =
    summary.metadata?.http && typeof summary.metadata.http === "object"
      ? (summary.metadata.http as Record<string, unknown>)
      : {};
  return {
    ...summary,
    gaps,
    metadata: {
      ...(summary.metadata ?? {}),
      http: {
        ...existingHttp,
        declaredContract: {
          framework: "ts-rest",
          responses,
        },
      },
    },
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
      boundaryBinding: { protocol: "http", framework: "fetch" },
    },
    inputs: [],
    transitions,
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
    ...(metadata !== undefined ? { metadata } : {}),
  };
}
