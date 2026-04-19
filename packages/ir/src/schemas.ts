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
  /**
   * Two or more providers at the same boundary declare contracts that
   * disagree — e.g. OpenAPI spec says statuses {200, 400, 404} but the
   * CFN template's MethodResponses says {200, 400, 404, _500}. Emitted
   * by checkContractAgreement; attribution lists every contributing
   * source in `Finding.sources`.
   */
  "contractDisagreement",
  /**
   * A declared-scenario source (Storybook story, fixture, example
   * payload) references a prop / arg the target unit doesn't declare
   * as an input. Almost always means the scenario is outdated — the
   * component removed or renamed a prop but the scenario wasn't
   * updated. Emitted by the component/story agreement check.
   */
  "scenarioArgUnknown",
  /**
   * A component has a conditional branch that depends on a prop,
   * and no declared scenario (Storybook story, fixture, etc.)
   * exercises that branch. Emitted by the component/story
   * agreement check — a genuine behavioral gap: the component
   * has logic that no story tests, so changes to that branch
   * can regress silently.
   */
  "scenarioCoverageGap",
  /**
   * A GraphQL consumer operation selects a root-level field
   * (Query.*, Mutation.*, Subscription.*) that no provider
   * resolver implements. Emitted by the operation→resolver
   * pairing pass when an operation touches a field for which
   * no `graphql-resolver(typeName, fieldName)` summary exists
   * in the visible set. A strong signal the consumer is out
   * of sync with the deployed schema — either the operation
   * got stale or the resolver was removed.
   */
  "graphqlFieldNotImplemented",
  /**
   * A GraphQL consumer operation selects a nested field on an
   * object type that the provider's schema doesn't declare.
   * Example: operation selects `pet { deletedAt }` but the
   * schema's `Pet` type has no `deletedAt` field. Emitted by
   * the nested-selection pass when the provider's
   * `metadata.graphql.schemaSdl` surfaces a type whose field
   * set excludes the consumer's selection.
   */
  "graphqlSelectionFieldUnknown",
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

// ---------------------------------------------------------------------------
// Boundary binding — three-layer model (see docs/boundary-semantics.md)
// ---------------------------------------------------------------------------
//
// `transport` is the wire/carrier (http, in-process, aws-https, etc).
// `semantics` is the discriminated union the checker dispatches on — what
//  the participants think they're doing (REST resource, in-process function
//  call, GraphQL operation when that lands).
// `recognition` is the pack identity that produced this binding ("ts-rest",
//  "react", "openapi-stub", …) — used for provenance and pack-level dedupe,
//  not for pairing or discriminator dispatch.

export const RestSemanticsSchema = z.object({
  name: z.literal("rest"),
  /** Uppercase HTTP method ("GET", "POST", …). */
  method: z.string(),
  /** Normalized route path ("/users/{id}"). */
  path: z.string(),
  /**
   * Status codes the producing source explicitly declared (OpenAPI
   * responses, CFN MethodResponses, ts-rest router statuses). Kept here
   * so the pairing layer can still see them without unwrapping metadata.
   * Empty / absent for inferred sources.
   */
  declaredResponses: z.array(z.number()).optional(),
});

export const FunctionCallSemanticsSchema = z.object({
  name: z.literal("function-call"),
  /**
   * Optional module identifier for cross-unit references
   * (e.g. `"./components/Button"` for a React component, or the TS
   * module path for a bare function export). Packs that don't do
   * cross-module pairing can leave it unset.
   */
  module: z.string().optional(),
  /** Named export within the module, when applicable. */
  exportName: z.string().optional(),
});

/**
 * Provider-side GraphQL resolver. One resolver binds one
 * (typeName, fieldName) pair. Discrimination at the resolver level
 * rather than field level — each resolver function is the smallest
 * independently-schedulable unit, and partial-null / per-field error
 * behavior is a property of the resolver, not the surrounding type.
 *
 * Pairing key: `${typeName}.${fieldName}`. Transport-agnostic —
 * resolvers run under Apollo Server (HTTP), AppSync (aws-https /
 * AppSync integration), yoga, or stitched gateways alike.
 */
export const GraphqlResolverSemanticsSchema = z.object({
  name: z.literal("graphql-resolver"),
  /** GraphQL type the resolver attaches to: "Query", "Mutation", "Subscription", or an object-type name like "User". */
  typeName: z.string(),
  /** Field name on that type. */
  fieldName: z.string(),
});

/**
 * Consumer-side GraphQL operation — a document sent from client to
 * server. Binds to an operation by name + operation type. Pairs with
 * the matching resolver(s) at runtime; checking is more involved
 * than REST pairing (one operation can touch many resolvers via
 * selection set), and is deferred until the consumer-side pack lands.
 */
export const GraphqlOperationSemanticsSchema = z.object({
  name: z.literal("graphql-operation"),
  /** Optional operation name — anonymous queries / mutations leave this unset. */
  operationName: z.string().optional(),
  operationType: z.enum(["query", "mutation", "subscription"]),
});

export const SemanticsSchema = z.discriminatedUnion("name", [
  RestSemanticsSchema,
  FunctionCallSemanticsSchema,
  GraphqlResolverSemanticsSchema,
  GraphqlOperationSemanticsSchema,
]);

export const BoundaryBindingSchema = z.object({
  transport: z.string(),
  semantics: SemanticsSchema,
  recognition: z.string(),
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
// Render tree — component-style output (React JSX, Vue templates, etc.)
// ---------------------------------------------------------------------------

type RenderNodeT =
  | {
      type: "element";
      tag: string;
      /**
       * Raw JSX attributes on the opening element, keyed by name and
       * mapped to the *source text* of the attribute's value. String-
       * literal attributes include their surrounding quotes (`type="button"`
       * → `"\"button\""`); expression-valued attributes include the full
       * expression (`onClick` → `"() => setCount(count + 1)"`); boolean
       * shorthand attributes (`<input disabled>`) map to the empty
       * string. No interpretation happens here — consumers that care
       * about event semantics (React's `onX` convention, Storybook's
       * `play` function targets) apply their own naming rules to
       * resolve handler summary identities. Omitted when the element
       * has no attributes (keeps tree output terse for text-heavy
       * templates).
       */
      attrs?: Record<string, string> | undefined;
      children: RenderNodeT[];
    }
  | { type: "text"; value: string }
  | { type: "expression"; sourceText: string }
  | {
      // Inline JSX conditionals: `{cond && <X/>}`, `{cond ? <A/> : <B/>}`,
      // `{cond ? <A/> : null}`. The `condition` carries the test
      // expression's source text verbatim — downstream consumers that
      // want a structured predicate can re-parse it, but preserving the
      // text means the summary stays legible without binding to the
      // current predicate decomposer.
      //
      // `whenTrue` is the branch rendered when the condition is truthy.
      // `whenFalse` is the branch rendered when falsy; null means the
      // conditional has no else (the `cond && <X/>` case) or the else
      // is explicitly `null` in source. Both alternatives render
      // nothing when absent — React treats `null`, `false`, and
      // `undefined` children as empty. Deliberately avoiding `then` /
      // `else` to sidestep the thenable-lookalike footgun: any object
      // with a `then` property can trip loose duck-typing checks in
      // older libraries, and the ESTree `consequent` / `alternate`
      // vocabulary needs parser-author context to read.
      type: "conditional";
      condition: string;
      whenTrue: RenderNodeT;
      whenFalse: RenderNodeT | null;
    };

export const RenderNodeSchema: z.ZodType<RenderNodeT> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("element"),
      tag: z.string(),
      attrs: z.record(z.string(), z.string()).optional(),
      children: z.array(RenderNodeSchema),
    }),
    z.object({ type: z.literal("text"), value: z.string() }),
    z.object({ type: z.literal("expression"), sourceText: z.string() }),
    z.object({
      type: z.literal("conditional"),
      condition: z.string(),
      whenTrue: RenderNodeSchema,
      whenFalse: RenderNodeSchema.nullable(),
    }),
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
    /**
     * Optional full rendered-tree shape. Packs that understand their
     * source language's render form (JSX, Vue templates, Svelte
     * markup) populate this so cross-boundary checking can compare
     * structural output against stubbed contracts (snapshots,
     * Storybook stories, Figma variants). Consumers that only care
     * about the root element read `component`; those that want the
     * full tree read `root`.
     */
    root: RenderNodeSchema.optional(),
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
