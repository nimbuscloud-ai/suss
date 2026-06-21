// @suss/ir-core schemas — primitives shared by every suss IR.
//
// These are the types that any IR built on top of suss references:
// the shape of a value (`TypeShape`), the identity of a boundary
// (`BoundaryBinding` + its `Semantics` variants), where something
// lives in source (`SourceLocation`), and how much to trust a claim
// (`Confidence`). Behavioural summaries, intent docs, and (later)
// observation records all speak in these terms, so they live in one
// place that none of those IRs has to depend on each other to reach.
//
// Schemas are the single source of truth; the package's `index.ts`
// derives the types via `z.infer`.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Confidence — how a claim was produced and how much to trust it.
// ---------------------------------------------------------------------------

export const ConfidenceSourceSchema = z.enum([
  "inferred_static",
  "inferred_ai",
  "declared",
  "derived",
]);

export const ConfidenceLevelSchema = z.enum(["high", "medium", "low"]);

export const ConfidenceInfoSchema = z.object({
  source: ConfidenceSourceSchema,
  level: ConfidenceLevelSchema,
});

// ---------------------------------------------------------------------------
// Source location.
// ---------------------------------------------------------------------------

export const SourceLocationSchema = z.object({
  file: z.string(),
  range: z.object({ start: z.number(), end: z.number() }),
  exportName: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Boundary semantics — the discriminated union that gives a boundary
// its pairing rule. New transports/semantics are added as variants.
// ---------------------------------------------------------------------------

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
   */
  exportPath: z.array(z.string()).optional(),
});

/**
 * Provider-side GraphQL resolver. One resolver binds one
 * (typeName, fieldName) pair. Pairing key: `${typeName}.${fieldName}`.
 */
export const GraphqlResolverSemanticsSchema = z.object({
  name: z.literal("graphql-resolver"),
  /** GraphQL type the resolver attaches to: "Query", "Mutation", "Subscription", or an object-type name. */
  typeName: z.string(),
  /** Field name on that type. */
  fieldName: z.string(),
});

/**
 * Consumer-side GraphQL operation — a document sent from client to
 * server. Binds by operation name + type.
 */
export const GraphqlOperationSemanticsSchema = z.object({
  name: z.literal("graphql-operation"),
  /** Optional operation name — anonymous queries / mutations leave this unset. */
  operationName: z.string().optional(),
  operationType: z.enum(["query", "mutation", "subscription"]),
});

/**
 * Provider-side runtime configuration channel — env vars + their
 * declared values on a deployable unit. The channel is the boundary;
 * env var names are FIELDS on its contract. Pairing key:
 * `(deploymentTarget, instanceName)`.
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
   * ID for Lambda / ECS, k8s deployment name, container name.
   */
  instanceName: z.string(),
});

/**
 * Provider-side relational storage table. Columns are FIELDS on the
 * table's contract. Pairing key: `(storageSystem, scope, table)`.
 */
export const StorageRelationalSemanticsSchema = z.object({
  name: z.literal("storage-relational"),
  storageSystem: z.enum(["postgres", "mysql", "sqlite"]),
  /**
   * ORM / driver scope. Defaults to `"default"` for single-database
   * setups; monorepos with multiple schemas use distinct values.
   */
  scope: z.string(),
  /** Table / model name as declared in the schema. */
  table: z.string(),
});

/**
 * Provider-side message-bus boundary — SQS / BullMQ / Kafka / NATS.
 * Producer `interaction(class: "message-send")` effects pair against
 * these via `(messageBus, channel)`.
 */
export const MessageBusSemanticsSchema = z.object({
  name: z.literal("message-bus"),
  messageBus: z.enum(["sqs", "bullmq", "kafka", "nats"]),
  /** Stable channel identifier — CFN logical id, queue/topic name, subject pattern. */
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

// ---------------------------------------------------------------------------
// Boundary binding — three-layer model: transport (the wire), semantics
// (the pairing rule), recognition (how the unit was found).
// ---------------------------------------------------------------------------

export const BoundaryBindingSchema = z.object({
  transport: z.string(),
  semantics: SemanticsSchema,
  recognition: z.string(),
});

// ---------------------------------------------------------------------------
// TypeShape — the structural shape of a value, used for body / payload
// / field comparison across every IR.
// ---------------------------------------------------------------------------

// Exported as a named type (not just `z.infer`) so that consuming
// packages' declaration files reference `TypeShape` by name across the
// package boundary rather than inlining this recursive union — inlining
// blows their .d.ts up by orders of magnitude.
export type TypeShape =
  | {
      type: "record";
      properties: Record<string, TypeShape>;
      spreads?: Array<{ sourceText: string }> | undefined;
    }
  | { type: "dictionary"; values: TypeShape }
  | { type: "array"; items: TypeShape }
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
  | { type: "union"; variants: TypeShape[] }
  | { type: "ref"; name: string }
  | { type: "unknown" };

export const TypeShapeSchema: z.ZodType<TypeShape> = z.lazy(() =>
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
