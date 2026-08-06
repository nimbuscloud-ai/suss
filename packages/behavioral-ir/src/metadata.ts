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

import type { BehavioralSummary, Transition } from "./index.js";

/**
 * What the message-bus contract reader records beside a summary's
 * binding: the queue a consumer drains, the rule or subscription and
 * bus a subscription came from, how far a rule's EventPattern, an SNS
 * FilterPolicy, or an S3 notification Filter reduced, and which S3
 * event and target an S3 bucket notification names.
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
  /** Label of the SNS subscription a consumer summary came from: the standalone AWS::SNS::Subscription's logical id, a synthesized label for an inline entry, or the SAM event name. */
  subscription: z.string().optional(),
  /** Label of the S3 bucket notification a consumer summary came from: a synthesized index into LambdaConfigurations/QueueConfigurations/TopicConfigurations, or the SAM event name. */
  notification: z.string().optional(),
  /** S3 event type a bucket notification matches, e.g. "s3:ObjectCreated:*". */
  event: z.string().optional(),
  /** CFN logical id of the SNS topic an S3 TopicConfiguration notifies, recorded on its own bucket-channelled consumer since an SNS topic isn't a deployableUnit. */
  topic: z.string().optional(),
  /** SAM event name the subscription was declared under. */
  eventName: z.string().optional(),
  /** How far an EventPattern, an SNS FilterPolicy, or an S3 notification Filter reduced; see the CFN reader. */
  patternResolution: z.enum(["exact", "schedule", "unresolvable"]).optional(),
  /** Present when unresolvable: what stopped the reduction. */
  unresolvableReason: z.string().optional(),
  /** Whether a declared queue is FIFO. */
  fifoQueue: z.boolean().optional(),
  /** Whether a declared SNS topic is FIFO. */
  fifoTopic: z.boolean().optional(),
  /** Physical QueueName, TopicName, or BucketName when the template sets one. */
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

const HttpContractProvenanceSchema = z.enum(["derived", "independent"]);

/**
 * "derived": the contract comes from the same source that drives this
 * summary's `transitions[]`. An OpenAPI stub's contract and its
 * transitions both come from the same operation's `responses` block,
 * so comparing them against each other is tautological.
 * "independent": a separate statement, such as CFN `MethodResponses`
 * against an integration-derived transition, or a ts-rest router
 * declaration against its handler implementation. Worth comparing.
 *
 * Defaults to "independent" when a writer doesn't say; surfacing a
 * spurious-but-investigable finding beats missing one that mattered.
 */
export type HttpContractProvenance = z.infer<
  typeof HttpContractProvenanceSchema
>;

/**
 * A declared response contract for one HTTP boundary: the status codes
 * a source promises and, where the source states it, each one's body
 * shape. Two sources naming the same boundary each carry one of these,
 * and the checker compares them.
 */
const HttpDeclaredContractSchema = z.object({
  /** Framework / source tag the producing pack records. */
  framework: z.string().optional(),
  responses: z.array(
    z.object({
      statusCode: z.number(),
      /** Response body shape, when the source declares one. */
      body: TypeShapeSchema.nullish(),
    }),
  ),
  provenance: HttpContractProvenanceSchema.default("independent"),
});

export type HttpDeclaredContract = z.infer<typeof HttpDeclaredContractSchema>;

/**
 * Pointer from a declared route to the code that implements it, a SAM
 * Lambda proxy integration's `Handler`, say. Generic "where is the
 * code" identity, not any one manifest's semantics, so a checker can
 * later correlate the declared route with the extracted handler summary
 * that carries the same REST binding. Purely additive.
 */
const HttpHandlerPointerSchema = z.object({
  /** Raw handler reference, e.g. "src/handlers/confirmToken.handler". */
  handler: z.string(),
  /** Module-path portion (before the final dot). */
  modulePath: z.string(),
  /** Exported symbol the handler names. */
  exportName: z.string(),
  /** Base directory the module path resolves against (SAM CodeUri). */
  codeUri: z.string().optional(),
  /** Logical id of the function resource that declared the handler. */
  functionLogicalId: z.string().optional(),
});

/**
 * What an HTTP contract reader records beside a summary's binding: the
 * declared response contract, the accessors a consumer's response
 * wrapper uses to reach the body and the status code, a pointer to the
 * code that implements a declared route, and the status-code range a
 * range response ("2XX", "4XX", and so on) covers.
 *
 * Every field but `statusRange` lives on a summary's own metadata.
 * `statusRange` lives on the transition it describes instead. A range
 * belongs to one response, not to the boundary as a whole, and the IR's
 * `statusCode` field only holds a literal value or none.
 */
export const HttpMetadataSchema = z.object({
  /**
   * The contract this summary's own transitions should be checked
   * against, or, for a summary a contract reader produces with no
   * handler body behind it, the contract itself.
   * `checkContractConsistency` and `checkContractAgreement` pair it
   * against another source describing the same boundary.
   */
  declaredContract: HttpDeclaredContractSchema.optional(),
  /**
   * Names of pack-declared response properties whose semantics is
   * `body`: `["data"]` for axios, `["body","json","text"]` for fetch.
   * Lets the checker unwrap a consumer's expected shape without knowing
   * each pack. Falls back to `["body"]` when absent.
   */
  bodyAccessors: z.array(z.string()).optional(),
  /**
   * Names of pack-declared response properties whose semantics is
   * `statusCode`: fetch and axios both use `status`. Falls back to
   * `["status", "statusCode"]` when absent.
   */
  statusAccessors: z.array(z.string()).optional(),
  /** Code that implements this declared route, when the manifest names it. */
  implementingHandler: HttpHandlerPointerSchema.optional(),
  /** The range spec ("2XX", "5xx", and so on) this transition's response covers. */
  statusRange: z
    .object({ min: z.number(), max: z.number(), spec: z.string() })
    .optional(),
});

export type HttpMetadata = z.infer<typeof HttpMetadataSchema>;

/**
 * A metadata bag with the http namespace set. Writes are strict: a
 * field the schema does not name throws here, next to its cause. Reads
 * stay lenient so older artifacts keep reading.
 */
export function withHttpMetadata(
  metadata: Record<string, unknown> | undefined,
  value: HttpMetadata,
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    http: HttpMetadataSchema.strict().parse(value),
  };
}

/**
 * The http namespace on a summary or one of its transitions, or
 * undefined when absent or not an object. Most fields live on a
 * summary; `statusRange` lives on the transition it describes. Both
 * carry a `metadata` bag of the same shape, so one reader covers both.
 */
export function readHttpMetadata(
  carrier: BehavioralSummary | Transition,
): HttpMetadata | undefined {
  return readNamespace(HttpMetadataSchema, carrier.metadata?.http);
}
