/**
 * The typed namespaces inside a summary's metadata bag.
 *
 * A namespace is a claim two parties share: a contract reader writes it
 * and a checker or renderer reads it back. Both sides import the schema
 * from here, so renaming a field is a compile error at both ends. While
 * this was only a convention, writers and readers cast the same objects
 * by hand and renaming a key made findings disappear with no error
 * anywhere.
 *
 * Reading validates one field at a time. A field that does not parse
 * gets dropped and its siblings still come through, so an artifact
 * written before a namespace changed gives up what it still can.
 */

import { z } from "zod";

import { TypeShapeSchema } from "@suss/ir-core";

import type { BehavioralSummary, Transition } from "./index.js";

/**
 * What the message-bus contract reader records beside a summary's
 * binding: the queue a consumer drains, the rule or subscription and
 * bus a subscription came from, how far a rule's EventPattern, an SNS
 * FilterPolicy, or an S3 notification Filter reduced, and which S3
 * events and target an S3 bucket notification points at.
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
  /** S3 event types a bucket notification matches, e.g. ["s3:ObjectCreated:*"]. A LambdaConfiguration/QueueConfiguration/TopicConfiguration's Event gives one; SAM's Events on a Type: S3 event source can list several. */
  events: z.array(z.string()).optional(),
  /** CFN logical id of the SNS topic an S3 TopicConfiguration notifies, recorded on its own bucket-channelled consumer since an SNS topic isn't a deployableUnit. */
  topic: z.string().optional(),
  /** SAM event name the subscription was declared under. */
  eventName: z.string().optional(),
  /** How far an EventPattern, an SNS FilterPolicy, or an S3 notification Filter reduced; see the CFN reader. */
  patternResolution: z.enum(["exact", "schedule", "unresolvable"]).optional(),
  /** Present when unresolvable: what stopped the reduction. */
  unresolvableReason: z.string().optional(),
  /**
   * Whether a scheduled rule deploys switched on, when the manifest
   * says. A rule deployed disabled invokes nothing until someone turns
   * it on, so a consumer with `false` here is wired but idle. Absent
   * means the manifest did not say, and the platform default is on.
   */
  enabled: z.boolean().optional(),
  /**
   * "sqs" when an SNS subscription delivers through a queue rather
   * than invoking the function directly, the SAM SqsSubscription
   * shape. The `queue` field then says which queue, or
   * "<sam-managed>" for the one SAM creates outside the template.
   */
  deliveredThrough: z.literal("sqs").optional(),
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
 * strict: a field the schema does not declare throws here, next to its
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
 * The fields of the namespace that parse, or undefined when the entry
 * is absent or is not an object. Validating one field at a time means
 * a single bad field never takes its siblings down with it.
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
  /**
   * Language runtime the manifest declares for the unit, verbatim:
   * a SAM `Runtime` or a serverless.yml `runtime`, e.g. "nodejs20.x"
   * or "python3.12". Absent when the manifest does not say.
   */
  runtime: z.string().optional(),
});

export type RuntimeContractMetadata = z.infer<
  typeof RuntimeContractMetadataSchema
>;

/**
 * A metadata bag with the runtime-contract namespace set. Writes are
 * strict: a field the schema does not declare throws here, next to its
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

/**
 * One condition a listener rule's (or a listener's own default action's)
 * match tests: a CFN condition `Field` (`path-pattern`, `host-header`,
 * `http-request-method`, `http-header`, `query-string`, `source-ip`, or
 * null when the template gives none) and the values it lists, ORed
 * within the field. `evaluated` is true only for `path-pattern` and
 * `host-header` in v0; every other field is still recorded as data,
 * without ever being treated as admitting a request, so a later
 * matching pass has something to widen into rather than a silent gap.
 */
const RoutingMatchConditionSchema = z.object({
  field: z.string().nullable(),
  values: z.array(z.string()),
  evaluated: z.boolean(),
});

/**
 * A non-forward action's response: the fixed-response listener default
 * the flow-reachability fixture uses gives a status, a content type,
 * and a body. Other non-forward action types (redirect,
 * authenticate-cognito, authenticate-oidc) still produce a record, with
 * `type` set to the action's own CFN type string and no further fields,
 * since v0 does not read them. Null when the template declares no
 * action at all.
 */
const RoutingResponseSchema = z.object({
  type: z.string().nullable(),
  statusCode: z.number().optional(),
  contentType: z.string().optional(),
  body: z.string().optional(),
});

/**
 * A reference the template makes that the CFN reader could not resolve
 * to a declared resource of the expected kind: the value as written (or
 * its JSON when it is not a plain string), and why resolution stopped.
 * Recorded rather than dropped, so an edge with nothing behind it in
 * the template is a fact about the template, not a gap in the reader.
 */
const UnresolvedRoutingRefSchema = z.object({
  reference: z.string(),
  reason: z.string(),
});

/**
 * What the ALB flow contract reader records beside a summary's
 * identity: one row per routing edge `docs/internal/proposals/
 * flow-reachability.md` describes. `edge` says which relation this
 * summary states; the other fields contain that relation's own data. One
 * summary states exactly one edge, the same way one CFN resource states
 * one thing.
 *
 *   routesTo   a listener rule, or a listener's own forward default
 *              action, naming the target group its match forwards to.
 *   answers    a listener rule's or a listener's own non-forward
 *              action: the response a matched (or unmatched, for a
 *              listener default) path gets without forwarding
 *              anywhere.
 *   fronts     a target group naming the resource that backs it.
 *   belongsTo  a listener naming the load balancer it belongs to, so
 *              a chain of balancers (an NLB fronting an ALB) composes:
 *              a `fronts` edge ends at the fronted balancer's logical
 *              id, and this edge is how a walk continues into that
 *              balancer's own listeners.
 */
export const RoutingMetadataSchema = z.object({
  edge: z.enum(["routesTo", "answers", "fronts", "belongsTo"]),
  /** routesTo / answers: CFN logical id of the listener the match belongs to. belongsTo: the listener this record describes. */
  router: z.string().nullable().optional(),
  unresolvedRouter: UnresolvedRoutingRefSchema.optional(),
  /**
   * routesTo: CFN logical id of the forwarded-to target group. fronts:
   * CFN logical id of the target group this record describes (always
   * resolved, since it is the resource the reader is walking).
   */
  target: z.string().nullable().optional(),
  unresolvedTarget: UnresolvedRoutingRefSchema.optional(),
  /**
   * routesTo / answers: identifies the match record this edge belongs
   * to, a rule's own logical id, or `${listenerId}#default` for a
   * listener's own action. Several routesTo rows share one matchId when
   * a weighted forward action lists more than one target group.
   */
  matchId: z.string().optional(),
  /** routesTo / answers: the rule's Priority. Absent for a listener's own default action, which CFN gives no priority. */
  priority: z.number().optional(),
  /** routesTo / answers: every condition field the rule declares. Empty when the rule (or the listener default) declares none. */
  conditions: z.array(RoutingMatchConditionSchema).optional(),
  /**
   * routesTo / answers: which condition language the match's
   * conditions are written in ("alb"), so a reachability pass can hand
   * the record to the matcher that owns that language. The languages
   * disagree in corners (an ALB `*` crosses `/`; Express changed its
   * own rules across majors), so no matcher may evaluate a record
   * outside its language: a match whose language has no matcher is
   * reachable-unknown, never admitted and never refused.
   */
  matchLanguage: z.string().optional(),
  /** routesTo: this target's share of a weighted ForwardConfig, when the action lists more than one target group. */
  weight: z.number().optional(),
  /** answers: the non-forward action's own response. */
  response: RoutingResponseSchema.optional(),
  /**
   * fronts: the resource backing the target group, an ECS container's
   * or a Lambda function's `instanceName`, or another load balancer's
   * logical id when a target group fronts one directly (an NLB in
   * front of an ALB). belongsTo: the load balancer the listener
   * belongs to. Spelled the same way the resource's own summary spells
   * itself, so a later join finds it by string equality.
   */
  resource: z.string().nullable().optional(),
  unresolvedResource: UnresolvedRoutingRefSchema.optional(),
});

export type RoutingMetadata = z.infer<typeof RoutingMetadataSchema>;

/**
 * A metadata bag with the routing namespace set. Writes are strict: a
 * field the schema does not name throws here, next to its cause. Reads
 * stay lenient so older artifacts keep reading.
 */
export function withRoutingMetadata(
  metadata: Record<string, unknown> | undefined,
  value: RoutingMetadata,
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    routing: RoutingMetadataSchema.strict().parse(value),
  };
}

/** The summary's routing namespace, or undefined when absent or not an object. */
export function readRoutingMetadata(
  summary: BehavioralSummary,
): RoutingMetadata | undefined {
  return readNamespace(RoutingMetadataSchema, summary.metadata?.routing);
}

const GraphqlContractProvenanceSchema = z.enum(["derived", "independent"]);

/**
 * "derived": the contract and this summary's transitions come from the
 * same source (an SDL field driving both), so comparing them against
 * each other would be tautological. "independent": a separate
 * statement, such as a server-side framework's own type declarations
 * against an SDL, worth comparing.
 */
export type GraphqlContractProvenance = z.infer<
  typeof GraphqlContractProvenanceSchema
>;

/**
 * A resolver field's declared shape, as one source states it: a return
 * type, its arguments, and the error types it may throw. Two sources
 * naming the same `Type.field` boundary each have one of these, and
 * the checker compares them.
 */
const GraphqlDeclaredContractSchema = z.object({
  /** Declared return shape for this resolver field. */
  returnType: TypeShapeSchema,
  /**
   * Declared arguments. Order matters when contract sources disagree,
   * since some frameworks make argument order part of the resolver's
   * identity (NestJS decorators) though GraphQL args have names.
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
   * Defaults to "independent" when a source doesn't say. Investigating
   * a spurious agreement finding beats quietly dropping one that counts.
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
 * which root field a resolver or operation is for, the contract another
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
   * Raw operation document text a consumer sent: a `.graphql` file's
   * contents, or the inner text of a `gql`-tagged template. Absent
   * when the document body wasn't statically readable.
   */
  document: z.string().optional(),
  /**
   * Fragment spreads a document reader could not resolve against its
   * read set. Their selections are missing from `document`, left as
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
 * Defaults to "independent" when a writer doesn't say. A spurious
 * finding someone can look into beats missing one that mattered.
 */
export type HttpContractProvenance = z.infer<
  typeof HttpContractProvenanceSchema
>;

/**
 * A declared response contract for one HTTP boundary: the status codes
 * a source promises and, where the source states it, each one's body
 * shape. Two sources naming the same boundary each have one of these,
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
 * that has the same REST binding.
 */
const HttpHandlerPointerSchema = z.object({
  /** Raw handler reference, e.g. "src/handlers/confirmToken.handler". */
  handler: z.string(),
  /** Module-path portion (before the final dot). */
  modulePath: z.string(),
  /** Name of the exported symbol the handler refers to. */
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
 * `statusCode` field only records a literal value or nothing at all.
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
  /** Code that implements this declared route, when the manifest says which. */
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
 * have a `metadata` bag of the same kind, so one reader covers both.
 */
export function readHttpMetadata(
  carrier: BehavioralSummary | Transition,
): HttpMetadata | undefined {
  return readNamespace(HttpMetadataSchema, carrier.metadata?.http);
}

const LibraryEnvReadsSchema = z.object({
  /** Module-specifier prefix of the library that does the reading. */
  module: z.string(),
  prefixes: z.array(z.string()).optional(),
  names: z.array(z.string()).optional(),
});

export type LibraryEnvReads = z.infer<typeof LibraryEnvReadsSchema>;

/**
 * Env vars a library reads from inside node_modules, declared by the
 * pack that covers the library and stamped on a marker summary at
 * extract time. The runtime-config pairing consults these before
 * calling a declared variable unused, since the reading code is never
 * walked.
 */
export function readLibraryEnvReads(
  summary: BehavioralSummary,
): LibraryEnvReads | undefined {
  return readNamespace(
    LibraryEnvReadsSchema,
    summary.metadata?.libraryEnvReads,
  );
}

const ModuleImportsSchema = z.array(z.string());

/**
 * The project files a summary's own file imports directly, or
 * undefined when the extractor recorded none. Paths are relative to
 * the same root as `location.file`. A checker working from summaries
 * alone rebuilds the module graph from these, which is how a runtime's
 * scope becomes its handler entry's import closure.
 */
export function readModuleImports(
  summary: BehavioralSummary,
): string[] | undefined {
  const parsed = ModuleImportsSchema.safeParse(summary.metadata?.moduleImports);
  return parsed.success ? parsed.data : undefined;
}
