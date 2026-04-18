// schemas.ts — zod schemas for the behavioral summary IR.
//
// Single source of truth: the TypeScript types in `index.ts` are derived
// from these schemas via `z.infer`, and the JSON Schema published to
// `schema/behavioral-summary.schema.json` is generated from them at build
// time via `z.toJSONSchema`. Hand-edit only this file.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const CodeUnitKindSchema = z.enum([
  "handler",
  "loader",
  "action",
  "component",
  "hook",
  "middleware",
  "resolver",
  "consumer",
  "client",
  "worker",
]);

export const ComparisonOpSchema = z.enum([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
]);

export const OpaqueReasonSchema = z.enum([
  "complexExpression",
  "externalFunction",
  "dynamicValue",
  "unsupportedSyntax",
]);

export const FindingKindSchema = z.enum([
  "unhandledProviderCase",
  "deadConsumerBranch",
  "providerContractViolation",
  "consumerContractViolation",
  "lowConfidence",
]);

export const FindingSeveritySchema = z.enum(["error", "warning", "info"]);

export const ConfidenceSourceSchema = z.enum([
  "inferred_static",
  "inferred_ai",
  "declared",
  "stub",
]);

export const ConfidenceLevelSchema = z.enum(["high", "medium", "low"]);

// ---------------------------------------------------------------------------
// Leaf object schemas
// ---------------------------------------------------------------------------

export const SourceLocationSchema = z.object({
  file: z.string(),
  range: z.object({ start: z.number(), end: z.number() }),
  exportName: z.string().nullable(),
});

export const BoundaryBindingSchema = z.object({
  protocol: z.string(),
  method: z.string().optional(),
  path: z.string().optional(),
  framework: z.string(),
  declaredResponses: z.array(z.number()).optional(),
});

export const CodeUnitIdentitySchema = z.object({
  name: z.string(),
  exportPath: z.array(z.string()).nullable(),
  boundaryBinding: BoundaryBindingSchema.nullable(),
});

export const ConfidenceInfoSchema = z.object({
  source: ConfidenceSourceSchema,
  level: ConfidenceLevelSchema,
});

export const LiteralSchema = z.object({
  type: z.literal("literal"),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
});

export const DerivationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("propertyAccess"), property: z.string() }),
  z.object({
    type: z.literal("methodCall"),
    method: z.string(),
    args: z.array(z.string()),
  }),
  z.object({ type: z.literal("destructured"), field: z.string() }),
  z.object({ type: z.literal("awaited") }),
  z.object({
    type: z.literal("indexAccess"),
    index: z.union([z.string(), z.number()]),
  }),
]);

// ---------------------------------------------------------------------------
// Recursive shapes — ValueRef, Predicate, TypeShape
// ---------------------------------------------------------------------------
//
// zod v4 handles recursion via `z.lazy()` with an explicit type annotation.
// The recursive structures below cross-reference each other (Predicate
// contains ValueRef; TypeShape contains TypeShape; Output contains
// ValueRef and TypeShape).

export interface ValueRef {
  type: "input" | "dependency" | "derived" | "literal" | "state" | "unresolved";
}

export interface Derivation {
  type:
    | "propertyAccess"
    | "methodCall"
    | "destructured"
    | "awaited"
    | "indexAccess";
}

// Forward type declarations for recursive schemas. The zod schemas below
// produce types compatible with these.
type ValueRefT =
  | { type: "input"; inputRef: string; path: string[] }
  | { type: "dependency"; name: string; accessChain: string[] }
  | {
      type: "derived";
      from: ValueRefT;
      derivation: z.infer<typeof DerivationSchema>;
    }
  | { type: "literal"; value: string | number | boolean | null }
  | { type: "state"; name: string }
  | { type: "unresolved"; sourceText: string };

export const ValueRefSchema: z.ZodType<ValueRefT> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("input"),
      inputRef: z.string(),
      path: z.array(z.string()),
    }),
    z.object({
      type: z.literal("dependency"),
      name: z.string(),
      accessChain: z.array(z.string()),
    }),
    z.object({
      type: z.literal("derived"),
      from: ValueRefSchema,
      derivation: DerivationSchema,
    }),
    LiteralSchema,
    z.object({ type: z.literal("state"), name: z.string() }),
    z.object({ type: z.literal("unresolved"), sourceText: z.string() }),
  ]),
);

type PredicateT =
  | { type: "nullCheck"; subject: ValueRefT; negated: boolean }
  | { type: "truthinessCheck"; subject: ValueRefT; negated: boolean }
  | {
      type: "comparison";
      left: ValueRefT;
      op: z.infer<typeof ComparisonOpSchema>;
      right: ValueRefT;
    }
  | { type: "typeCheck"; subject: ValueRefT; expectedType: string }
  | {
      type: "propertyExists";
      subject: ValueRefT;
      property: string;
      negated: boolean;
    }
  | { type: "compound"; op: "and" | "or"; operands: PredicateT[] }
  | { type: "negation"; operand: PredicateT }
  | { type: "call"; callee: string; args: ValueRefT[] }
  | {
      type: "opaque";
      sourceText: string;
      reason: z.infer<typeof OpaqueReasonSchema>;
    };

export const PredicateSchema: z.ZodType<PredicateT> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("nullCheck"),
      subject: ValueRefSchema,
      negated: z.boolean(),
    }),
    z.object({
      type: z.literal("truthinessCheck"),
      subject: ValueRefSchema,
      negated: z.boolean(),
    }),
    z.object({
      type: z.literal("comparison"),
      left: ValueRefSchema,
      op: ComparisonOpSchema,
      right: ValueRefSchema,
    }),
    z.object({
      type: z.literal("typeCheck"),
      subject: ValueRefSchema,
      expectedType: z.string(),
    }),
    z.object({
      type: z.literal("propertyExists"),
      subject: ValueRefSchema,
      property: z.string(),
      negated: z.boolean(),
    }),
    z.object({
      type: z.literal("compound"),
      op: z.enum(["and", "or"]),
      operands: z.array(PredicateSchema),
    }),
    z.object({ type: z.literal("negation"), operand: PredicateSchema }),
    z.object({
      type: z.literal("call"),
      callee: z.string(),
      args: z.array(ValueRefSchema),
    }),
    z.object({
      type: z.literal("opaque"),
      sourceText: z.string(),
      reason: OpaqueReasonSchema,
    }),
  ]),
);

type TypeShapeT =
  | {
      type: "record";
      properties: Record<string, TypeShapeT>;
      spreads?: Array<{ sourceText: string }> | undefined;
    }
  | { type: "dictionary"; values: TypeShapeT }
  | { type: "array"; items: TypeShapeT }
  | {
      type: "literal";
      value: string | number | boolean;
      raw?: string | undefined;
    }
  | { type: "text" }
  | { type: "integer" }
  | { type: "number" }
  | { type: "boolean" }
  | { type: "null" }
  | { type: "undefined" }
  | { type: "union"; variants: TypeShapeT[] }
  | { type: "ref"; name: string }
  | { type: "unknown" };

export const TypeShapeSchema: z.ZodType<TypeShapeT> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("record"),
      properties: z.record(z.string(), TypeShapeSchema),
      spreads: z.array(z.object({ sourceText: z.string() })).optional(),
    }),
    z.object({ type: z.literal("dictionary"), values: TypeShapeSchema }),
    z.object({ type: z.literal("array"), items: TypeShapeSchema }),
    z.object({
      type: z.literal("literal"),
      value: z.union([z.string(), z.number(), z.boolean()]),
      raw: z.string().optional(),
    }),
    z.object({ type: z.literal("text") }),
    z.object({ type: z.literal("integer") }),
    z.object({ type: z.literal("number") }),
    z.object({ type: z.literal("boolean") }),
    z.object({ type: z.literal("null") }),
    z.object({ type: z.literal("undefined") }),
    z.object({
      type: z.literal("union"),
      variants: z.array(TypeShapeSchema),
    }),
    z.object({ type: z.literal("ref"), name: z.string() }),
    z.object({ type: z.literal("unknown") }),
  ]),
);

// ---------------------------------------------------------------------------
// Inputs, Outputs, Effects
// ---------------------------------------------------------------------------

export const InputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("parameter"),
    name: z.string(),
    position: z.number(),
    role: z.string(),
    shape: TypeShapeSchema.nullable(),
  }),
  z.object({
    type: z.literal("injection"),
    name: z.string(),
    mechanism: z.string(),
    shape: TypeShapeSchema.nullable(),
  }),
  z.object({
    type: z.literal("hookReturn"),
    hook: z.string(),
    destructuredFields: z.array(z.string()),
  }),
  z.object({
    type: z.literal("contextValue"),
    context: z.string(),
    accessedFields: z.array(z.string()),
  }),
  z.object({ type: z.literal("closure"), name: z.string() }),
]);

export const OutputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("response"),
    statusCode: ValueRefSchema.nullable(),
    body: TypeShapeSchema.nullable(),
    headers: z.record(z.string(), ValueRefSchema),
  }),
  z.object({
    type: z.literal("throw"),
    exceptionType: z.string().nullable(),
    message: z.string().nullable(),
  }),
  z.object({
    type: z.literal("render"),
    component: z.string(),
    props: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    type: z.literal("return"),
    value: TypeShapeSchema.nullable(),
  }),
  z.object({ type: z.literal("delegate"), to: z.string() }),
  z.object({
    type: z.literal("emit"),
    event: z.string(),
    payload: TypeShapeSchema.optional(),
  }),
  z.object({ type: z.literal("void") }),
]);

export const EffectSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("mutation"),
    target: z.string(),
    operation: z.enum(["create", "update", "delete"]),
  }),
  z.object({
    type: z.literal("invocation"),
    callee: z.string(),
    args: z.array(z.unknown()),
    async: z.boolean(),
  }),
  z.object({
    type: z.literal("emission"),
    event: z.string(),
    payload: z.unknown().optional(),
  }),
  z.object({
    type: z.literal("stateChange"),
    variable: z.string(),
    newValue: z.unknown().optional(),
  }),
]);

// ---------------------------------------------------------------------------
// Transition, Gap, BehavioralSummary
// ---------------------------------------------------------------------------

export const TransitionSchema = z.object({
  id: z.string(),
  conditions: z.array(PredicateSchema),
  output: OutputSchema,
  effects: z.array(EffectSchema),
  location: z.object({ start: z.number(), end: z.number() }),
  isDefault: z.boolean(),
  confidence: ConfidenceInfoSchema.optional(),
  expectedInput: TypeShapeSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const GapSchema = z.object({
  type: z.literal("unhandledCase"),
  conditions: z.array(PredicateSchema),
  consequence: z.enum([
    "frameworkDefault",
    "implicitThrow",
    "fallthrough",
    "unknown",
  ]),
  description: z.string(),
});

export const BehavioralSummarySchema = z.object({
  kind: CodeUnitKindSchema,
  location: SourceLocationSchema,
  identity: CodeUnitIdentitySchema,
  inputs: z.array(InputSchema),
  transitions: z.array(TransitionSchema),
  gaps: z.array(GapSchema),
  confidence: ConfidenceInfoSchema,
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const BehavioralSummaryArraySchema = z.array(BehavioralSummarySchema);

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

export const FindingSideSchema = z.object({
  summary: z.string(),
  transitionId: z.string().optional(),
  location: SourceLocationSchema,
});

export const FindingSuppressionSchema = z.object({
  /** Human-written explanation from the .sussignore rule. Required. */
  reason: z.string(),
  /**
   * What happened to this finding:
   *   - "mark": still shown and returned; excluded from exit-code
   *     threshold calculations. Default.
   *   - "downgrade": severity dropped one level (error -> warning ->
   *     info); still counted toward exit code at the downgraded level.
   *   - "hide": filtered from output and exit code entirely. The
   *     `suppressed` annotation survives only for downstream JSON
   *     consumers that want to see what was silenced.
   */
  effect: z.enum(["mark", "downgrade", "hide"]),
  /**
   * Original severity before downgrade, preserved so downstream tools
   * can distinguish "this was always info" from "this was downgraded
   * from error to info." Present only when effect is "downgrade".
   */
  originalSeverity: FindingSeveritySchema.optional(),
});

export const FindingSchema = z.object({
  kind: FindingKindSchema,
  boundary: BoundaryBindingSchema,
  provider: FindingSideSchema,
  consumer: FindingSideSchema,
  description: z.string(),
  severity: FindingSeveritySchema,
  /**
   * Present only when two or more identical findings (same kind,
   * boundary, description, consumer) from different providers were
   * collapsed by the checker's dedup pass. Each entry is a
   * `${file}::${name}` identifier matching FindingSide.summary.
   * Single-source findings leave this unset. The `provider` field
   * above still points at one representative contributor.
   */
  sources: z.array(z.string()).optional(),
  /**
   * Present only when a .sussignore rule matched this finding. The
   * `effect` tells downstream tools how the finding was handled;
   * `reason` is the rule's human-written justification.
   */
  suppressed: FindingSuppressionSchema.optional(),
});

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

export const SummaryDiffSchema = z.object({
  addedTransitions: z.array(TransitionSchema),
  removedTransitions: z.array(TransitionSchema),
  changedTransitions: z.array(
    z.object({ before: TransitionSchema, after: TransitionSchema }),
  ),
});
