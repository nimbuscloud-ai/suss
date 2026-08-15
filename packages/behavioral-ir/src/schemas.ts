/**
 * The zod schemas for the behavioral summary IR, and the one place any
 * of it is written by hand.
 *
 * Everything else is generated from what is here. The TypeScript types
 * exported from `index.ts` come from these schemas through `z.infer`,
 * and the JSON Schema the package publishes is generated at build time
 * through `z.toJSONSchema`. Edit a schema here and both follow; edit
 * either of those directly and the next build throws it away.
 *
 * The primitives shared with the other suss IRs come from
 * `@suss/ir-core`, and the schemas below build on them. What this
 * package exports is the types plus the parse functions, not these.
 */

import { z } from "zod";

import {
  BoundaryBindingSchema,
  ConfidenceInfoSchema,
  DeployableUnitSchema,
  SourceLocationSchema,
  TypeShapeSchema,
} from "@suss/ir-core/schemas";

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
  /**
   * A function reachable from a package's `package.json` entry points,
   * the provider side of an in-process `function-call` boundary.
   */
  "library",
  /** The consumer side, one unit per function that calls into a package. */
  "caller",
  /**
   * What a module does when it is first imported, one per source file.
   * Always a consumer: it reads channels other units declare.
   */
  "module-init",
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
  /** Two providers at one boundary declare contracts that disagree. */
  "contractDisagreement",
  /** A contract declares an operation no extracted provider implements. */
  "contractOperationUnimplemented",
  /** A REST consumer calls a method and path no provider exposes. */
  "restMethodOnUnknownPath",
  /** The provider requires authentication the consumer's call lacks. */
  "authPolicyMismatch",
  /** No declared scenario exercises a branch a component takes on a prop. */
  "scenarioCoverageGap",
  /** No code could be matched to a runtime, so nothing paired against its contract. */
  "runtimeScopeUnknown",
  /** Code requires an env var the runtime contract does not mark required. */
  "envVarRequiredButUnmarked",
  /** The consumer uses a field the provider's contract does not declare. */
  "boundaryFieldUnknown",
  /** An `aspect` of "read" means the field has writers but no reader. */
  "boundaryFieldUnused",
  /** Both sides declare the field and disagree about its type. */
  "boundaryShapeMismatch",
  /** The provider requires a field the consumer does not supply. */
  "boundaryFieldRequired",
  /** The value has the declared type and breaks an enum or length rule. */
  "boundaryConstraintViolation",
  /** Code sends to a queue or topic no provider in scope declares. */
  "messageBusProducerOrphan",
  /** A consumer receives from a channel nothing in the project sends to. */
  "messageBusConsumerOrphan",
  /** A declared queue or topic nothing produces to or consumes from. */
  "messageBusUnused",
  /** A pack marked a boundary it cannot summarise, so nothing will pair. */
  "unsupportedSemantics",
  /** Too many predicates were opaque to pair on. Reported per pair, unlike `lowConfidence`. */
  "opaquePredicateBlocking",
]);

export const FindingSeveritySchema = z.enum(["error", "warning", "info"]);

/**
 * Which side of a field a boundary finding concerns. `send` and `receive`
 * are a payload's two directions; `construct` is a scenario setting an
 * input; `selector` is a query's `where` rather than its data.
 */
export const BoundaryAspectSchema = z.enum([
  "read",
  "write",
  "send",
  "receive",
  "construct",
  "selector",
]);

export const CodeUnitIdentitySchema = z.object({
  /** Workspace, file, and export path. Names alone collide by the hundreds. */
  id: z.string().optional(),
  name: z.string(),
  /**
   * "binding" means other code can call the unit by this name. "label"
   * means discovery coined it, and it never stands in for a binding.
   */
  nameKind: z.enum(["binding", "label"]).optional(),
  exportPath: z.array(z.string()).nullable(),
  boundaryBinding: BoundaryBindingSchema.nullable(),
  deployableUnit: DeployableUnitSchema.optional(),
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

// These types are hand-written rather than inferred because zod v4
// needs an explicit annotation on a `z.lazy()` to close the recursion.

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

// ---------------------------------------------------------------------------
// Render tree
// ---------------------------------------------------------------------------

type RenderNodeT =
  | {
      type: "element";
      tag: string;
      /**
       * Attribute values as source text, quotes included. A boolean
       * shorthand such as `<input disabled>` maps to the empty string.
       */
      attrs?: Record<string, string> | undefined;
      children: RenderNodeT[];
    }
  | { type: "text"; value: string }
  | { type: "expression"; sourceText: string }
  | {
      // A null `whenFalse` covers both `{cond && <X/>}` and an else
      // written as `null`; React renders nothing either way. They are
      // not called `then`/`else`: a `then` property makes a thenable.
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
    /**
     * What the parameter is for, in the library's own vocabulary. Null
     * when nobody could tell which role it has, rather than guessing;
     * the summary then includes a gap explaining why.
     */
    role: z.string().nullable(),
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
    /** The full rendered tree, when the pack understands the render form. */
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
    /**
     * The summary this call reaches, set only when exactly one summary in
     * the run matches `callee`. Absent when several did, since a guess
     * is worse than a gap.
     */
    summary: z.string().optional(),
    args: z.array(z.unknown()),
    async: z.boolean(),
    /** Absent for a call that always fires within its transition. */
    preconditions: z.array(PredicateSchema).optional(),
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
  /**
   * Code talking to something across a boundary. Every shipped recognizer
   * keeps `interaction.class` matching `binding.semantics.name`, though
   * the IR does not enforce it.
   */
  z.object({
    type: z.literal("interaction"),
    binding: BoundaryBindingSchema,
    /** Source text of the call expression, for inspect rendering. */
    callee: z.string().optional(),
    /** All the effects from one call site share this id. */
    groupId: z.string().optional(),
    /**
     * Where the work happens, when that is somewhere other than the unit's
     * own body. A recognizer that walks into a called function sets this to
     * the function it stepped into, so a reader can go there. Absent means
     * the call is written in the unit itself.
     */
    origin: z
      .object({
        file: z.string(),
        line: z.number(),
        function: z.string().optional(),
      })
      .optional(),
    preconditions: z.array(PredicateSchema).optional(),
    interaction: z.discriminatedUnion("class", [
      z.object({
        class: z.literal("storage-access"),
        kind: z.enum(["read", "write"]),
        fields: z.array(z.string()),
        selector: z.array(z.string()).optional(),
        operation: z.string().optional(),
      }),
      z.object({
        class: z.literal("service-call"),
        method: z.string(),
        payload: z.unknown().optional(),
        responseShape: TypeShapeSchema.optional(),
      }),
      z.object({
        class: z.literal("message-send"),
        body: z.unknown().optional(),
        routingKey: z.string().optional(),
      }),
      /**
       * The fields a consumer pulls out of a message, with no channel,
       * since a handler signature does not say which one it is for. The
       * checker uses the enclosing summary's `binding.semantics.channel`.
       */
      z.object({
        class: z.literal("message-receive"),
        body: z.unknown().optional(),
      }),
      z.object({
        class: z.literal("config-read"),
        name: z.string(),
        defaulted: z.boolean(),
      }),
      /**
       * A scheduled callback. Nothing pairs against these, so the
       * enclosing binding uses `function-call` semantics and the
       * interaction is there for dataflow and inspect rendering.
       * `hasDelay` says a delay argument was passed, not what it was.
       */
      z.object({
        class: z.literal("schedule"),
        via: z.enum([
          "setImmediate",
          "setTimeout",
          "setInterval",
          "queueMicrotask",
          "process.nextTick",
        ]),
        callbackRef: z.discriminatedUnion("type", [
          z.object({ type: z.literal("literal") }),
          z.object({ type: z.literal("identifier"), name: z.string() }),
          z.object({ type: z.literal("opaque"), reason: z.string() }),
        ]),
        hasDelay: z.boolean(),
      }),
    ]),
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
  /**
   * "unhandledCase" is a statement about the code. "unreadOutcome"
   * means no pack terminal matched part of what the unit produces, so a
   * checker should not count that against the handler.
   */
  type: z.enum(["unhandledCase", "unreadOutcome"]),
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
  /** Absent means version 1, which parse entry points normalize first. */
  schemaVersion: z.number().optional(),
  kind: CodeUnitKindSchema,
  location: SourceLocationSchema,
  identity: CodeUnitIdentitySchema,
  inputs: z.array(InputSchema),
  transitions: z.array(TransitionSchema),
  gaps: z.array(GapSchema),
  confidence: ConfidenceInfoSchema,
  /** Keyed the way `typeDefinitionKey` builds a key out of a ref. */
  definitions: z.record(z.string(), TypeShapeSchema).optional(),
  /** What this unit reads out of the values it was given, once each. */
  inputReads: z
    .array(z.object({ input: z.string(), path: z.array(z.string()) }))
    .optional(),
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
  /** The .sussignore rule's own explanation. */
  reason: z.string(),
  /**
   * "mark" still shows the finding but drops it from the exit code.
   * "downgrade" drops the severity one level and still counts it there.
   * "hide" keeps it out of both, and survives only in the JSON output.
   */
  effect: z.enum(["mark", "downgrade", "hide"]),
  /** The severity before a downgrade. Present only for "downgrade". */
  originalSeverity: FindingSeveritySchema.optional(),
});

export const FindingSchema = z.object({
  kind: FindingKindSchema,
  boundary: BoundaryBindingSchema,
  provider: FindingSideSchema,
  consumer: FindingSideSchema,
  description: z.string(),
  severity: FindingSeveritySchema,
  aspect: BoundaryAspectSchema.optional(),
  /**
   * Every provider that contributed, when identical findings from several
   * of them were collapsed into one. `provider` above is one of them.
   */
  sources: z.array(z.string()).optional(),
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
