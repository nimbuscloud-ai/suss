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

/**
 * The result of corroborating a claim against real execution
 * (`suss corroborate`): generated inputs satisfying the claim's own
 * conditions were run through the actual function and the observation
 * either agreed every time (`observed`), disagreed at least once
 * (`refuted` — an extractor bug or a genuine surprise; the
 * counterexample says which input), or never produced a verdict
 * (`untested` — no satisfying input was found, or every satisfying
 * run hit a dependency the harness cannot supply).
 *
 * Corroboration upgrades a *derivation* with *observations*; it is
 * additive evidence, never a rewrite of the derived claim.
 */
export const CorroborationSchema = z.object({
  outcome: z.enum(["observed", "refuted", "untested"]),
  /** Executions that produced a verdict for this claim. */
  runs: z.number(),
  /** Present when refuted: the input and observation that disagreed. */
  counterexample: z.unknown().optional(),
  /** Present when untested: why no verdict was reachable. */
  reason: z.string().optional(),
});

export const ConfidenceInfoSchema = z.object({
  source: ConfidenceSourceSchema,
  level: ConfidenceLevelSchema,
  corroboration: CorroborationSchema.optional(),
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
 * One thing that gets deployed and runs on its own: a Lambda
 * function, an ECS task's container, a plain container, a k8s
 * deployment.
 *
 * `instanceName` is the stable identifier the deployment medium uses:
 * the CFN logical resource id for Lambda and ECS, the deployment name
 * for k8s, the container name for a plain container.
 */
export const DeployableUnitSchema = z.object({
  deploymentTarget: z.enum([
    "lambda",
    "ecs-task",
    "container",
    "k8s-deployment",
  ]),
  // An empty name would agree with every other empty name, so a unit
  // that names nothing has to leave the field off instead.
  instanceName: z.string().min(1),
});

/**
 * Provider-side runtime configuration channel: env vars and their
 * declared values on a deployable unit. The channel is the boundary;
 * env var names are FIELDS on its contract. Pairing key:
 * `(deploymentTarget, instanceName)`, which is exactly a deployable
 * unit, so the two fields come from `DeployableUnitSchema` rather
 * than being spelled a second time.
 */
export const RuntimeConfigSemanticsSchema = DeployableUnitSchema.extend({
  name: z.literal("runtime-config"),
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
 * Provider-side message-bus boundary — SQS / EventBridge / BullMQ /
 * Kafka / NATS. Producer `interaction(class: "message-send")` effects
 * pair against these via `(messageBus, channel)`.
 *
 * The `channel` string is per-bus. SQS keys it on the single queue
 * identity (CFN logical id / env-var name). EventBridge carries a
 * two-part identity — the event bus AND the DetailType a rule matches —
 * encoded as `"<bus>#<detailType>"`, because one bus multiplexes many
 * event types and a rule subscribes to a subset. See
 * `@suss/framework-aws-eventbridge` for the producer-side scheme and
 * `@suss/contract-cloudformation`'s messageBus reader for the
 * consumer/provider-side scheme.
 */
export const MessageBusSemanticsSchema = z.object({
  name: z.literal("message-bus"),
  messageBus: z.enum(["sqs", "eventbridge", "bullmq", "kafka", "nats"]),
  /** Stable channel identifier — CFN logical id, queue/topic name, subject pattern, `bus#detailType`. */
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
  | {
      type: "ref";
      name: string;
      /**
       * Where this type is written down, when it is. The key into the
       * summary's table of definitions.
       *
       * A name does not identify a type. Every instantiation of one
       * generic reports the generic's own name and file, so `Omit<User,
       * "secret">` and `Omit<Order, "total">` are both `Omit`, and a
       * table keyed on that hands the second one the first one's
       * fields. This is built from what the type actually is.
       */
      def?: string | undefined;
      /**
       * The file that declares this type, when the project declares it.
       * Absent for a name the language or a dependency owns, which means
       * the same thing everywhere.
       *
       * A name on its own does not identify a type. Two modules each
       * declaring a `User` produce the same ref, and a checker comparing
       * them has nothing to go on. This is what tells them apart.
       */
      from?: string | undefined;
    }
  | { type: "unknown" };

/**
 * How a table of definitions names the type a ref points at.
 *
 * A ref carries the name and the file that declares it, and that pair
 * already identifies the type, so a table keyed on it needs nothing new
 * on the ref. A name the language or a dependency owns has no file and
 * keys on the name alone.
 */
export function typeDefinitionKey(ref: {
  def?: string | undefined;
}): string | null {
  return ref.def ?? null;
}

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
    z.object({
      type: z.literal("ref"),
      name: z.string(),
      from: z.string().optional(),
      def: z.string().optional(),
    }),
    z.object({ type: z.literal("unknown") }),
  ]),
);

/**
 * How deep a shape is walked while definitions are put back.
 *
 * The same number the shape walk itself stops at, so a shape read from
 * a table looks like the one that was never in a table.
 */
const MAX_DEFINITION_DEPTH = 6;

/**
 * A shape with the definitions it names put back into it.
 *
 * Comparing two shapes means comparing their structure, and a ref has
 * none. Rather than teach every comparison to look in a table, the
 * table goes back into the shape once, and everything downstream reads
 * what it always read.
 *
 * Putting a definition back is a substitution rather than a level of
 * nesting, so it does not spend depth. Counting it did: a type six
 * deep came back three deep, and a consumer reading a field past that
 * point was told the provider did not have it. What stops a type that
 * names itself is the set of names already being put back on this
 * path, which is how the shape walk guards its own cycles.
 */
export function withDefinitionsInlined(
  shape: TypeShape,
  definitions: Record<string, TypeShape> | undefined,
  depth = 0,
  inProgress: ReadonlySet<string> = new Set(),
): TypeShape {
  if (definitions === undefined || depth >= MAX_DEFINITION_DEPTH) {
    return shape;
  }
  const deeper = (inner: TypeShape): TypeShape =>
    withDefinitionsInlined(inner, definitions, depth + 1, inProgress);

  if (shape.type === "ref") {
    const key = typeDefinitionKey(shape);
    // A ref with no key was never written down, which is what a name
    // the language owns looks like.
    if (key === null) {
      return shape;
    }
    const defined = definitions[key];
    // A ref naming nothing in the table stays a ref, which is what it
    // means: this is the name, and nobody wrote the type down. A name
    // already on this path stays a ref too, or a type that names itself
    // would be put back for ever.
    if (defined === undefined || inProgress.has(key)) {
      return shape;
    }
    return withDefinitionsInlined(
      defined,
      definitions,
      depth,
      new Set([...inProgress, key]),
    );
  }
  if (shape.type === "record") {
    const properties: Record<string, TypeShape> = {};
    for (const [name, value] of Object.entries(shape.properties)) {
      properties[name] = deeper(value);
    }
    return { ...shape, properties };
  }
  if (shape.type === "array") {
    return { ...shape, items: deeper(shape.items) };
  }
  if (shape.type === "dictionary") {
    return { ...shape, values: deeper(shape.values) };
  }
  if (shape.type === "union") {
    return { ...shape, variants: shape.variants.map(deeper) };
  }
  return shape;
}
