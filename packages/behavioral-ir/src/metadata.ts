// metadata.ts: the typed namespaces inside a summary's metadata bag.
//
// A namespace is a claim two parties share: a contract reader writes
// it and a checker or renderer reads it back. Both sides import the
// schema here, so a renamed field is a compile error at both ends. It
// used to be a convention: eight writers and nine readers hand-cast
// the same shapes, and a renamed key made findings evaporate with no
// error anywhere.
//
// Reads validate field by field. A field that does not parse is
// dropped and its siblings keep reading, so an artifact written
// before a namespace changed keeps answering what it still can.

import { z } from "zod";

import { TypeShapeSchema } from "@suss/ir-core";

import type { BehavioralSummary } from "./index.js";

/**
 * What the message-bus contract reader records beside a summary's
 * binding: the queue a consumer drains, the rule and bus an
 * EventBridge subscription came from, and how far the rule's pattern
 * reduced.
 */
export const MessageBusMetadataSchema = z.object({
  /** CFN logical id of the queue a subject-channelled consumer drains. */
  queue: z.string().optional(),
  /** Subject routed into the drained queue, when a rule routes one. */
  subject: z.string().optional(),
  /** The event bus a rule or subscription belongs to. */
  eventBus: z.string().optional(),
  /** DetailType a rule matches, when it reduces to exactly one. */
  detailType: z.string().optional(),
  /** Label of the rule a consumer summary came from. */
  rule: z.string().optional(),
  /** SAM event name the subscription was declared under. */
  eventName: z.string().optional(),
  /** How far an EventPattern reduced; see the CFN reader. */
  patternResolution: z.enum(["exact", "schedule", "unresolvable"]).optional(),
  /** Present when unresolvable: what stopped the reduction. */
  unresolvableReason: z.string().optional(),
  /** Whether a declared queue is FIFO. */
  fifoQueue: z.boolean().optional(),
  /** Physical QueueName when the template sets one. */
  physicalName: z.string().optional(),
});

export type MessageBusMetadata = z.infer<typeof MessageBusMetadataSchema>;

/**
 * A metadata bag with the message-bus namespace set. Writes are
 * strict: a field the schema does not name throws here, next to its
 * cause. Reads stay lenient so older artifacts keep reading.
 */
export function withMessageBusMetadata(
  metadata: Record<string, unknown> | undefined,
  value: MessageBusMetadata,
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    messageBus: MessageBusMetadataSchema.strict().parse(value),
  };
}

/**
 * The namespace's fields that parse, field by field, or undefined
 * when the entry is absent or not an object. Per-field validation
 * matches the hand-written typeof checks this module replaced: one
 * bad field never takes its siblings down with it.
 */
function readNamespace<Shape extends z.ZodRawShape>(
  schema: z.ZodObject<Shape>,
  raw: unknown,
): z.infer<z.ZodObject<Shape>> | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const entries = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    const parsed = (field as z.ZodTypeAny).safeParse(entries[key]);
    if (parsed.success && parsed.data !== undefined) {
      out[key] = parsed.data;
    }
  }
  return out as z.infer<z.ZodObject<Shape>>;
}

/** The summary's message-bus namespace, or undefined when absent or not an object. */
export function readMessageBusMetadata(
  summary: BehavioralSummary,
): MessageBusMetadata | undefined {
  return readNamespace(MessageBusMetadataSchema, summary.metadata?.messageBus);
}

const EnvVarSourceSchema = z.enum(["template", "globals", "platform"]);

/**
 * Where a variable in a runtime's environment comes from: the
 * resource's own Environment block, a SAM Globals section the whole
 * document shares, or the platform the runtime runs on.
 */
export type EnvVarSource = z.infer<typeof EnvVarSourceSchema>;

/**
 * What the runtime-config contract reader records beside a summary's
 * binding: every environment variable the deployed process sees, where
 * each one came from, and which CFN resource an env var's value
 * resolves to when the template wires it to one.
 */
export const RuntimeContractMetadataSchema = z.object({
  /** Every env var the process sees, including ones the platform injects. */
  envVars: z.array(z.string()).optional(),
  /**
   * Per-var provenance: the resource's own Environment block
   * ("template"), a SAM Globals section every function in the document
   * inherits ("globals"), or the platform the runtime runs on
   * ("platform"). The pairing checker uses this so a platform-injected
   * var never fires an unused warning, and so a document-level default
   * is judged once for the document rather than function by function.
   * When this map is absent, every var is treated as declared by the
   * resource.
   */
  envVarSources: z.record(z.string(), EnvVarSourceSchema).optional(),
  /**
   * The CFN logical id an env var's value resolves to, when the
   * template sets it with a Ref or GetAtt. Bridges an env-var-named
   * channel (what code reads) to the resource-named channel (what a
   * provider summary declares), so cross-resource pairing can chain
   * through it.
   */
  envVarTargets: z
    .record(
      z.string(),
      z.object({ kind: z.literal("ref"), logicalId: z.string() }),
    )
    .optional(),
});

export type RuntimeContractMetadata = z.infer<
  typeof RuntimeContractMetadataSchema
>;

/**
 * A metadata bag with the runtime-contract namespace set. Writes are
 * strict: a field the schema does not name throws here, next to its
 * cause. Reads stay lenient so older artifacts keep reading.
 */
export function withRuntimeContractMetadata(
  metadata: Record<string, unknown> | undefined,
  value: RuntimeContractMetadata,
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    runtimeContract: RuntimeContractMetadataSchema.strict().parse(value),
  };
}

/** The summary's runtime-contract namespace, or undefined when absent or not an object. */
export function readRuntimeContractMetadata(
  summary: BehavioralSummary,
): RuntimeContractMetadata | undefined {
  return readNamespace(
    RuntimeContractMetadataSchema,
    summary.metadata?.runtimeContract,
  );
}

const GraphqlContractProvenanceSchema = z.enum(["derived", "independent"]);

/**
 * "derived": the contract and this summary's transitions come from the
 * same source (an SDL field driving both), so comparing them against
 * each other would be tautological. "independent": a separate
 * statement — a server-side framework's own type declarations against
 * an SDL, say — worth comparing.
 */
export type GraphqlContractProvenance = z.infer<
  typeof GraphqlContractProvenanceSchema
>;

/**
 * A resolver field's declared shape, as one source states it: a return
 * type, its arguments, and the error types it may throw. Two sources
 * naming the same `Type.field` boundary each carry one of these, and
 * the checker compares them.
 */
const GraphqlDeclaredContractSchema = z.object({
  /** Declared return shape for this resolver field. */
  returnType: TypeShapeSchema,
  /**
   * Declared arguments. Order matters when contract sources disagree —
   * argument order is part of the resolver's identity in some
   * frameworks (NestJS positional decorators) even though GraphQL
   * itself names args.
   */
  args: z.array(
    z.object({
      name: z.string(),
      type: TypeShapeSchema,
      required: z.boolean(),
    }),
  ),
  /**
   * Error variants the resolver may throw. Most contracts don't
   * enumerate these; absent means the source doesn't say, not "no
   * errors."
   */
  errorTypes: z.array(z.string()).optional(),
  /**
   * Defaults to "independent" when a source doesn't say — investigating
   * a spurious agreement finding beats silently dropping a real one.
   */
  provenance: GraphqlContractProvenanceSchema.default("independent"),
  /** Framework / source tag the producing pack records. */
  framework: z.string().optional(),
});

export type GraphqlDeclaredContract = z.infer<
  typeof GraphqlDeclaredContractSchema
>;

/**
 * What a GraphQL contract reader records beside a summary's binding:
 * which root field a resolver or operation names, the contract another
 * source can compare against, the operation document a consumer sent
 * (or the schema SDL behind a resolver), and how much of it the reader
 * could resolve.
 */
export const GraphqlMetadataSchema = z.object({
  /** Root type a resolver's field hangs off. */
  rootType: z.enum(["Query", "Mutation", "Subscription"]).optional(),
  /** Field name on the root type. */
  fieldName: z.string().optional(),
  /**
   * Declared contract for this resolver field, derived from an SDL or a
   * framework's own type declarations. `checkGraphqlContractAgreement`
   * pairs it against any other source declaring a contract for the
   * same boundary.
   */
  declaredContract: GraphqlDeclaredContractSchema.optional(),
  /**
   * Schema SDL behind a resolver, when the reader has it on hand
   * (AppSync's resolved schema, an Apollo code-first server's static
   * `typeDefs`). Lets the checker's pairing pass walk a consumer
   * operation's nested selections against the resolver's return type.
   */
  schemaSdl: z.string().optional(),
  /**
   * Raw operation document text a consumer sent — a `.graphql` file's
   * contents, or the inner text of a `gql`-tagged template. Absent
   * when the document body wasn't statically readable.
   */
  document: z.string().optional(),
  /**
   * Fragment spreads a document reader could not resolve against its
   * read set — their selections are absent from `document`, kept as
   * an unexpanded spread so the document still parses.
   */
  unresolvedFragments: z.array(z.string()).optional(),
  /**
   * Set when a consumer's document reference was recognized (an
   * imported `TypedDocumentNode`, say) but its body couldn't be read
   * statically. The boundary is still recorded; this says what
   * defeated resolution rather than dropping it silently.
   */
  unresolvedDocument: z
    .object({ reference: z.string(), reason: z.string() })
    .optional(),
});

export type GraphqlMetadata = z.infer<typeof GraphqlMetadataSchema>;

/**
 * A metadata bag with the graphql namespace set. Writes are strict: a
 * field the schema does not name throws here, next to its cause. Reads
 * stay lenient so older artifacts keep reading.
 */
export function withGraphqlMetadata(
  metadata: Record<string, unknown> | undefined,
  value: GraphqlMetadata,
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    graphql: GraphqlMetadataSchema.strict().parse(value),
  };
}

/** The summary's graphql namespace, or undefined when absent or not an object. */
export function readGraphqlMetadata(
  summary: BehavioralSummary,
): GraphqlMetadata | undefined {
  return readNamespace(GraphqlMetadataSchema, summary.metadata?.graphql);
}
