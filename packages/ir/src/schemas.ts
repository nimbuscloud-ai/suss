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
  /**
   * A function exposed through a TypeScript package's public export
   * surface — i.e. reachable from the package's `package.json` entry
   * points (`main` / `module` / `types` / `exports`). Provider side of
   * an in-process `function-call` boundary: downstream callers
   * consuming `import { fn } from "pkg"` are paired against these.
   */
  "library",
  /**
   * A function that calls into another package's public export surface
   * — the consumer side of an in-process `function-call` boundary.
   * Produced by the `packageImport` discovery variant, one unit per
   * enclosing function that invokes an imported binding. Pairs with
   * `library`-kind provider summaries by `package + exportPath`.
   */
  "caller",
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
   * A REST consumer call targets a (method, path) combination
   * the provider doesn't expose. Today the pairing layer just
   * leaves both summaries unmatched, which silently obscures
   * what's likely a typo or stale endpoint reference.
   * Severity: error. Reserved in v0 taxonomy; emitter ships
   * when the pairing layer adds a "consumer with no provider"
   * surfaced finding distinct from "unmatched / no boundary
   * binding." Distinct from `boundaryFieldUnknown` because the
   * mismatch is at the boundary identity level, not at field level.
   */
  "restMethodOnUnknownPath",
  /**
   * Provider requires authentication (Bearer / API key / OAuth)
   * and consumer's call doesn't send it, sends a different
   * scheme, or lacks the required scope. Severity: error.
   * Reserved in v0 taxonomy; needs auth-policy modeling on
   * both sides — the OpenAPI security schemes and the
   * client-side header / interceptor patterns. Future work.
   * Distinct from the generic boundary kinds — auth policies are
   * boundary-level not field-level.
   */
  "authPolicyMismatch",
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
   * A runtime-config-bound provider summary declares no
   * codeScope (or one we couldn't resolve to source files), so
   * we can't pair its env-var contract against any code.
   * Emitted by checkRuntimeConfig as info — a heads-up that
   * verification was skipped, not a defect in the code itself.
   * Common cause: raw CloudFormation that uses S3-built
   * artifacts (no `CodeUri`) without a `Metadata.SussCodeScope`
   * annotation.
   */
  "runtimeScopeUnknown",
  /**
   * Code treats `process.env.X` as definitely-required (e.g.
   * `if (!process.env.X) throw …` or unconditional read), but
   * the runtime contract doesn't mark it as required (no
   * deployment-side validation, no documented requirement).
   * Severity: warning. Reserved in v0 taxonomy; emitter waits
   * for the runtime contract to grow a "required" attribute on
   * env-var entries (currently the contract is just the name
   * list). Distinct from the generic kinds — this is about
   * contract-side metadata (the var IS declared, just not marked
   * required), not about a field/shape disagreement.
   */
  "envVarRequiredButUnmarked",
  /**
   * Generic — consumer references a field that the provider's
   * contract doesn't declare. Subsumes the per-domain kinds that
   * shipped earlier (storageReadFieldUnknown, storageWriteFieldUnknown,
   * envVarUnprovided, graphqlFieldNotImplemented,
   * graphqlSelectionFieldUnknown, scenarioArgUnknown).
   *
   * The boundary's `binding.semantics.name` carries the domain
   * context (storage-relational, runtime-config, graphql-resolver,
   * function-call, …); the optional `Finding.aspect` distinguishes
   * read vs write vs construct, which matters for severity and
   * remediation. Emitted by every per-domain checker that pairs
   * consumer field references against provider field declarations.
   */
  "boundaryFieldUnknown",
  /**
   * Generic — provider declares a field that no consumer in the
   * analysed scope references. Subsumes storageFieldUnused,
   * storageWriteOnlyField, envVarUnused.
   *
   * `Finding.aspect` distinguishes "no consumer reads or writes" (no
   * aspect) from "no consumer reads, but writers exist" (aspect:
   * "read") — the latter is the write-only case. Default severity is
   * warning (dead config, not user-visible failure).
   */
  "boundaryFieldUnused",
  /**
   * Generic — both sides declare a field but disagree on its shape
   * (type, nullability, content-type, etc.). The `aspect` field
   * names which side discovered the disagreement (read / write /
   * send / receive / construct / selector). Severity is per-emitter;
   * some cases are runtime errors (write-side type mismatch on a
   * typed column) while others are silent coercions (read-side
   * env-var-as-number).
   *
   * Subsumes the per-domain shape-mismatch kinds earlier versions
   * reserved: storageTypeMismatch, storageNullableViolation,
   * storageSelectorIndexMismatch, envVarTypeCoercionMissing,
   * graphqlVariableTypeMismatch, requestBodyShapeMismatch,
   * componentPropTypeMismatch, contentTypeMismatch.
   */
  "boundaryShapeMismatch",
  /**
   * Generic — provider declares a field as required and the consumer
   * doesn't supply it. The `aspect` field names which payload (send /
   * construct, typically). Subsumes earlier per-domain reserved kinds:
   * requiredHeaderMissing, requiredQueryParamMissing,
   * componentRequiredPropMissing, graphqlRequiredArgMissing.
   *
   * Severity defaults to error — at runtime the provider rejects the
   * request, returns a 4xx, or the component fails to render.
   */
  "boundaryFieldRequired",
  /**
   * Generic — value supplied for a field violates a value-level
   * constraint declared by the provider (enum membership, declared
   * length, etc.). Distinct from `boundaryShapeMismatch` because the
   * value's TYPE is correct; only the value itself violates the
   * constraint. Subsumes earlier per-domain reserved kinds:
   * storageLengthConstraintViolation, storageEnumConstraintViolation,
   * graphqlEnumValueUnknown. Severity per-emitter.
   */
  "boundaryConstraintViolation",
  /**
   * Code sends a message to a queue / topic that no provider in the
   * analysed scope declares. Severity: WARNING (not error) — common
   * false-positive sources are multi-repo deployments (queue is
   * declared in another stack) and work-in-progress before infra is
   * wired up. The high-value message-bus finding is body-shape
   * mismatch (producer body vs consumer expected shape); that's
   * future work. Emitted by checkMessageBus.
   */
  "messageBusProducerOrphan",
  /**
   * A consumer Lambda is wired to receive from a channel but no code
   * in the project sends to that channel. Could be dead infra, or
   * the producer lives in a different repo we don't analyse.
   * Severity: warning.
   */
  "messageBusConsumerOrphan",
  /**
   * A queue / topic is declared in infrastructure but neither
   * produced to nor consumed from anywhere in the project. Likely
   * orphan resource left over from a removed feature. Severity:
   * warning.
   */
  "messageBusUnused",
  /**
   * A pack identifies a boundary it doesn't know how to
   * summarise — a WebSocket subscription handler, an SSE stream
   * producer, a gRPC streaming method, etc. Severity: info. The
   * pack should still emit a stub-shaped summary marking the
   * boundary's existence; this finding alerts users that the
   * extracted summary won't pair against consumers because the
   * semantics aren't modelled. Reserved in v0 taxonomy; emitter
   * ships when a pack first encounters a boundary it can't
   * fully describe.
   */
  "unsupportedSemantics",
  /**
   * A pairing pass refused to emit substantive findings because
   * too many predicates on the relevant transitions are opaque
   * (the extractor couldn't decompose them; preconditions /
   * branches show as raw source text). Severity: info. Distinct
   * from `lowConfidence`, which is per-summary; this is per-pair
   * — pairing produced no signal because the inputs were too
   * murky to reason over. Reserved in v0 taxonomy; emitter
   * ships when a pairing pass adds an explicit "I bailed"
   * disclosure.
   */
  "opaquePredicateBlocking",
]);

export const FindingSeveritySchema = z.enum(["error", "warning", "info"]);

/**
 * Names which "side" of a field a generic boundary finding concerns.
 * Lets `boundaryFieldUnknown` / `boundaryFieldUnused` /
 * `boundaryShapeMismatch` carry the read-vs-write-vs-construct
 * distinction without requiring a separate kind per direction.
 *
 * - `read`: consumer reads the field (e.g. `process.env.X`, Prisma
 *   `select: { X: true }`, GraphQL selection set)
 * - `write`: consumer writes the field (e.g. Prisma `data: { X: 1 }`)
 * - `send`: consumer sends a field on an outbound payload (request
 *   body, message body, GraphQL variable)
 * - `receive`: consumer reads a field from an inbound payload
 *   (response body field, message body field after parse)
 * - `construct`: scenario / fixture sets a field as input to its
 *   target (Storybook story passing a prop)
 * - `selector`: field appears in a query selector (Prisma `where`,
 *   index lookup) — distinct from data-side aspects since selector
 *   constraints differ
 *
 * Optional on findings; absent means the aspect is irrelevant or
 * the finding spans multiple aspects (e.g. `boundaryFieldUnused` with
 * no aspect = "no consumer reads OR writes this field at all").
 */
export const BoundaryAspectSchema = z.enum([
  "read",
  "write",
  "send",
  "receive",
  "construct",
  "selector",
]);

export const ConfidenceSourceSchema = z.enum([
  "inferred_static",
  "inferred_ai",
  "declared",
  "derived",
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
  /**
   * Package name (as written in `package.json`) when this identity
   * refers to a public package export — e.g. `"@suss/behavioral-ir"`.
   * Set alongside `exportPath` by packs that resolve a package's
   * public surface (the `packageExports` discovery variant). Distinct
   * from `module`, which is a repo-relative module path for
   * intra-repo pairing.
   */
  package: z.string().optional(),
  /**
   * Path to the exported binding within the package, starting with
   * the sub-path key when one is used. Examples:
   *   `["parseSummary"]`              — root export
   *   `["schemas", "BoundaryBindingSchema"]` — sub-path `./schemas`
   *
   * The first segment is the sub-path without the leading `./`
   * (`"."` → omitted). The last segment is the exported name.
   * Intermediate segments correspond to nested re-export structure
   * when a pack records it; most v0 packs use one-or-two-segment
   * paths.
   */
  exportPath: z.array(z.string()).optional(),
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

/**
 * Provider-side runtime configuration channel — env vars + their
 * declared values on a deployable unit (Lambda, ECS task, container,
 * k8s pod). The channel is the boundary; env var names are FIELDS on
 * its contract (analogous to `body.email` being a field on a REST
 * endpoint's contract). Pairing key: `(deploymentTarget, instanceName)`.
 * The list of env vars provided lives in `metadata.runtimeContract.envVars`
 * on the summary; `metadata.codeScope` declares which source files
 * run inside the channel so the pairing layer can scope code reads.
 */
export const RuntimeConfigSemanticsSchema = z.object({
  name: z.literal("runtime-config"),
  deploymentTarget: z.enum([
    "lambda",
    "ecs-task",
    "container",
    "k8s-deployment",
  ]),
  /**
   * Stable identifier for the runtime instance — CFN logical resource
   * ID for Lambda / ECS, k8s deployment name, container name. Pairs
   * across runs; survives template rename only when the underlying
   * physical name does.
   */
  instanceName: z.string(),
});

/**
 * Provider-side relational storage table — Postgres / MySQL / SQLite
 * declared via Prisma `model`, Drizzle `pgTable(...)`, TypeORM
 * `@Entity`, or raw SQL DDL. Columns are FIELDS on the table's
 * contract; field-level access checks compare what code reads/writes
 * against `metadata.storageContract.columns`. Pairing key:
 * `(storageSystem, scope, table)`.
 *
 * Other storage models (document, tabular-NoSQL, key-value, blob)
 * each get their own SemanticsSchema variant when those phases ship.
 */
export const StorageRelationalSemanticsSchema = z.object({
  name: z.literal("storage-relational"),
  storageSystem: z.enum(["postgres", "mysql", "sqlite"]),
  /**
   * ORM / driver scope. Defaults to `"default"` for single-database
   * setups; monorepos with multiple Prisma schemas or multiple
   * connection pools use distinct values to keep pairings separate.
   */
  scope: z.string(),
  /** Table / model name as declared in the schema. */
  table: z.string(),
});

/**
 * Provider-side message-bus boundary — SQS queue, BullMQ queue,
 * Kafka topic, NATS subject, or any FIFO/pub-sub channel that
 * carries discrete messages between producers and consumers.
 * Producer-side `interaction(class: "message-send")` effects pair
 * against these via `(messageBus, channel)`. Consumer-side handlers
 * gain a boundaryBinding of this same shape via the contract-source
 * pass that walks deployment manifests (CFN event-source mappings,
 * docker-compose worker configs, k8s controllers, etc.).
 */
export const MessageBusSemanticsSchema = z.object({
  name: z.literal("message-bus"),
  /**
   * Bus implementation. Drives the contract-source layer that
   * resolves channel identity from deployment manifests; checker
   * dispatches some behaviour (e.g. partition / routing semantics)
   * by this discriminator.
   */
  messageBus: z.enum(["sqs", "bullmq", "kafka", "nats"]),
  /**
   * Stable channel identifier — CFN logical resource ID for SQS /
   * SNS, queue name for BullMQ, topic name for Kafka, subject
   * pattern for NATS. Pairs across runs.
   */
  channel: z.string(),
});

export const SemanticsSchema = z.discriminatedUnion("name", [
  RestSemanticsSchema,
  FunctionCallSemanticsSchema,
  GraphqlResolverSemanticsSchema,
  GraphqlOperationSemanticsSchema,
  RuntimeConfigSemanticsSchema,
  StorageRelationalSemanticsSchema,
  MessageBusSemanticsSchema,
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
    /**
     * Ancestor conditions that gate reaching this call within its
     * enclosing transition — populated for calls nested inside
     * conditional blocks (`if (result === "nomatch") findings.push(...)`)
     * or loop bodies. Absent for unconditional, always-fires calls.
     * Same shape as Transition.conditions: opaque fallback when the
     * source condition couldn't be decomposed structurally.
     */
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
   * Outbound boundary interaction — code at line N talks to something
   * across a boundary. Discriminated by `interaction.class` so each
   * class carries the typed structural fields appropriate to its
   * operation shape (storage columns, service-call payload +
   * response, message body, env-var name).
   *
   * Class taxonomy (v0): storage-access, service-call, message-send,
   * config-read. Each maps 1:1 to a `binding.semantics.name`
   * (storage-relational, rest, message-bus, runtime-config) — that
   * convention is not enforced by the IR but every shipped recognizer
   * follows it.
   *
   * Subsumes what was previously a separate `storageAccess` Effect
   * variant. `interaction(class: "storage-access")` carries all the
   * same data: `binding.semantics` (StorageRelationalSemantics)
   * holds the (storageSystem, scope, table) identity, and
   * `interaction.{kind, fields, selector, operation}` holds the
   * operation details.
   */
  z.object({
    type: z.literal("interaction"),
    /** Boundary identity — drives pairing against provider summaries. */
    binding: BoundaryBindingSchema,
    /** Source-text of the call expression for inspect rendering. */
    callee: z.string().optional(),
    /**
     * Correlation id when one call site emits multiple effects (e.g.
     * a Prisma nested select that touches User AND Order — two
     * effects sharing a groupId reflect "these came from one query").
     */
    groupId: z.string().optional(),
    /**
     * Same shape as invocation.preconditions — ancestor conditions
     * that gate reaching this interaction within its transition.
     */
    preconditions: z.array(PredicateSchema).optional(),
    /**
     * Per-class operation shape. The discriminator is `class`; each
     * variant carries the typed fields appropriate to its operation.
     * Adding a class is a strictly additive IR change.
     */
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
       * Consumer-side body extraction from a message. Sister to
       * `message-send`: producer-side records what shape goes IN to
       * the queue / topic, consumer-side records what shape comes OUT.
       * Pairs against `message-send` by channel — the channel is
       * usually carried on the enclosing handler's CFN-declared
       * event-source mapping (consumer-side recognizers leave the
       * channel implicit because the SQS / Kafka handler signature
       * doesn't name it; the checker joins via the consumer summary's
       * `binding.semantics.channel`).
       *
       * `body` is the EffectArg-shaped extraction of the parsed
       * message — typically the destructured field set after
       * `JSON.parse(record.body)`, an `as Type` cast, or both.
       * Compared against the producer's `body` to detect field-name
       * or shape mismatches.
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
       * Runtime scheduling primitive — `setImmediate(fn)`,
       * `setTimeout(fn, ms)`, `queueMicrotask(fn)`, etc. The callback
       * `fn` is recorded separately (as a sub-unit when the analyzer
       * can resolve it to a literal function expression, or via the
       * `callbackRef` opaque marker when not).
       *
       * `via` names the scheduling API; `hasDelay` records whether a
       * delay argument was supplied at the call site (without
       * modeling its value — temporal semantics are out of v0 scope).
       *
       * Schedule effects don't pair against contracted boundaries —
       * scheduling isn't a contract — so the enclosing
       * Effect.binding carries a `function-call` semantics with the
       * scheduling pack as `recognition`. The interaction exists for
       * dataflow / inspect rendering, not for cross-unit pairing.
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
   * For generic boundary findings (`boundaryFieldUnknown`,
   * `boundaryFieldUnused`, `boundaryShapeMismatch`), names which
   * side of the field the finding concerns — read / write / send /
   * receive / construct / selector. See `BoundaryAspectSchema` for
   * the per-value semantics. Absent on findings where the aspect
   * is irrelevant (most non-generic kinds) or where the finding
   * spans multiple aspects.
   */
  aspect: BoundaryAspectSchema.optional(),
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
