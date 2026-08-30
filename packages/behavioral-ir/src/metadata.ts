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
   * "aws_sqs" when an SNS subscription delivers through a queue rather
   * than invoking the function directly, the SAM SqsSubscription
   * shape. The `queue` field then says which queue, or
   * "<sam-managed>" for the one SAM creates outside the template.
   */
  deliveredThrough: z.literal("aws_sqs").optional(),
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

const MountMetadataSchema = z.object({
  /**
   * How many mounts serve the declaration this boundary came from.
   * Every sibling records the same count, so a reader counting
   * declarations divides by it and a reader counting routes does not.
   */
  siblings: z.number(),
  /** The mount prefix this boundary took, which tells the siblings apart. */
  prefix: z.string(),
});

export type MountMetadata = z.infer<typeof MountMetadataSchema>;

/**
 * One route declaration served under several mounts emits one boundary
 * per mount, and each records this so nothing reads the siblings as
 * separate declarations.
 */
export function withMountMetadata(
  metadata: Record<string, unknown> | undefined,
  value: MountMetadata,
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    mount: MountMetadataSchema.strict().parse(value),
  };
}

export function readMountMetadata(
  summary: BehavioralSummary,
): MountMetadata | undefined {
  return readNamespace(MountMetadataSchema, summary.metadata?.mount);
}

const WrapperReferenceSchema = z.object({
  /** The file the wrapper is declared in, where its own summary is. */
  file: z.string(),
  /** The name that summary goes by in that file. */
  name: z.string(),
  /**
   * True when the framework invokes the wrapper only for a request that
   * ended by throwing, which is how an error handler is called.
   */
  onThrow: z.boolean().optional(),
  /** The path pattern the registration narrowed the wrapper to, if any. */
  scope: z.string().optional(),
});

const WrapperMetadataSchema = z.object({
  /** Every wrapper registered on the routable this unit was registered on. Set on a summary. */
  applied: z.array(WrapperReferenceSchema).optional(),
  /**
   * Set on a transition composition brought in: the wrapper whose body
   * produced this outcome. A transition the unit's own body produced
   * has none, which is how a reader tells the two apart.
   */
  from: WrapperReferenceSchema.optional(),
});

export type WrapperMetadata = z.infer<typeof WrapperMetadataSchema>;

/** One wrapper as the unit it runs around refers to it. */
export type WrapperReference = z.infer<typeof WrapperReferenceSchema>;

/**
 * A handler's wire behaviour is not only what its own body does.
 * Middleware, error handlers and validation hooks produce responses for
 * it without appearing in it, so a unit records which ones run around
 * it, and each outcome one of them contributed says which one that was.
 *
 * An `applied` entry points at the wrapper's own summary the way
 * `sourceDocument` points at a schema. What the wrapper does lives on
 * that summary, in its transitions.
 */
export function withWrapperMetadata(
  metadata: Record<string, unknown> | undefined,
  value: WrapperMetadata,
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    wrappers: WrapperMetadataSchema.strict().parse(value),
  };
}

/**
 * The wrappers namespace on a summary or one of its transitions.
 * `applied` lives on the summary and `from` on the transition, and both
 * carriers have a `metadata` bag of the same kind, so one reader covers
 * both.
 */
export function readWrapperMetadata(
  carrier: BehavioralSummary | Transition,
): WrapperMetadata | undefined {
  return readNamespace(WrapperMetadataSchema, carrier.metadata?.wrappers);
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
   * What an env var is set to, for the vars the manifest writes out as
   * plain text. A storage access whose container is the variable rather
   * than the name (`TableName: env.EDITION_TABLE`) reaches the table
   * through this, so it pairs with whatever declares that table. Absent
   * for a value the manifest does not state, a secret above all.
   */
  envVarValues: z.record(z.string(), z.string()).optional(),
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
 * identity: one row per routing edge `design/proposals/
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
   * The schema SDL, on the summary standing for the schema document
   * rather than on each resolver the document declares. The checker's
   * pairing pass finds it from a resolver through the document label
   * they share, and walks the consumer operation's nested selections
   * against the resolver's return type.
   *
   * A reader that has no document summary to put it on may still write
   * it beside a resolver, and the pairing pass reads that too.
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
   * Whether the project's client constructions install a fragment
   * registry, the one runtime mechanism that can supply a definition
   * for a spread the shipped document lacks. "absent" means every
   * construction was read and none installs one, so a dangling spread
   * throws when the query runs. "configured" means at least one does.
   * "unknown" means a construction could not be read, or none was
   * found. Written only beside `unresolvedFragments`, the gap it
   * settles.
   */
  fragmentRegistry: z.enum(["configured", "absent", "unknown"]).optional(),
  /**
   * Set when a consumer's document reference was recognized (an
   * imported `TypedDocumentNode`, say) but its body couldn't be read
   * statically. The boundary is still recorded; this says what
   * defeated resolution rather than dropping it silently.
   */
  unresolvedDocument: z
    .object({ reference: z.string(), reason: z.string() })
    .optional(),
  /**
   * The client a consumer operation goes through, read from the
   * project's client construction. `uri` when the construction wrote
   * a string literal; `uriRef` is the written expression (an env var
   * read, a config access) when the value is computed, a symbolic
   * reference a config binding can ground later. Absent when the
   * project constructs no client the packs describe, or more than one
   * distinct client and the operation cannot be attributed to one.
   */
  client: z
    .object({
      uri: z.string().nullable(),
      uriRef: z.string().nullable(),
      /**
       * The provider workspace this client is bound to, from the
       * pack's per-project config. The pairing pass keeps only the
       * matched resolvers from this workspace when it is set.
       */
      workspace: z.string().optional(),
    })
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

/**
 * The document a summary was read out of.
 *
 * One document declares many boundaries and states things every one of
 * them relies on: a GraphQL schema's type definitions, an OpenAPI
 * document's `components.schemas`. Those belong to the document, so a
 * reader puts them on a summary standing for the document and gives
 * every summary from that document the same label. A checker that needs
 * them goes from a boundary to its document and reads them once.
 *
 * The label is the one the reader records on `location.file`, so
 * `parseDocumentLabel` reads it the same way here as it does there.
 */
export const SourceDocumentMetadataSchema = z.object({
  label: z.string(),
});

export type SourceDocumentMetadata = z.infer<
  typeof SourceDocumentMetadataSchema
>;

/** A metadata bag saying which document its summary was read out of. */
export function withSourceDocumentMetadata(
  metadata: Record<string, unknown> | undefined,
  value: SourceDocumentMetadata,
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    sourceDocument: SourceDocumentMetadataSchema.strict().parse(value),
  };
}

/** The document namespace, or undefined when absent or not an object. */
export function readSourceDocumentMetadata(
  summary: BehavioralSummary,
): SourceDocumentMetadata | undefined {
  const read = readNamespace(
    SourceDocumentMetadataSchema,
    summary.metadata?.sourceDocument,
  );
  return read?.label === undefined ? undefined : read;
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
  /**
   * Responses a source declares by class rather than by one code, the
   * way OpenAPI writes "4XX". Such an entry promises some status
   * between `min` and `max`, without saying which, so a consumer branch
   * on any member agrees with the contract.
   */
  responseRanges: z
    .array(
      z.object({
        min: z.number(),
        max: z.number(),
        /** The spelling in the source ("2XX", "4xx"), for messages. */
        spec: z.string(),
        body: TypeShapeSchema.nullish(),
      }),
    )
    .optional(),
  /**
   * A catch-all response for every status the entries above leave out,
   * the way OpenAPI writes `default`. Its presence means no consumer
   * status is undeclared.
   */
  defaultResponse: z.object({ body: TypeShapeSchema.nullish() }).optional(),
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
  /**
   * Names of pack-declared response properties whose semantics is
   * `statusRange`: `["ok"]` for fetch, and nothing for axios, which has
   * no success flag. A consumer guarding on one of these handles the
   * whole 2xx class rather than one status. Falls back to `["ok"]` when
   * absent.
   */
  successAccessors: z.array(z.string()).optional(),
  /**
   * How the consumer's client hands back a response the server refused.
   * `"response"` is fetch, where the caller reads the status. `"exception"`
   * is axios and ky, where every non-2xx reaches the caller through a
   * `catch` and no status guard can be written. Falls back to
   * `"response"` when absent.
   */
  failureDelivery: z.enum(["response", "exception"]).optional(),
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

const StorageContractMetadataSchema = z.object({
  /**
   * Whether the fields below are every field an item has.
   * `"exhaustive"` is a SQL schema, `"partial"` a store that declares
   * its keys and lets the rest vary, `"none"` a blob or a string. Only
   * an exhaustive contract can call a field it does not declare
   * unknown, so a contract that says nothing here makes no such claim.
   * Summaries written before this field get `"exhaustive"` on the way in.
   */
  fieldSet: z.enum(["exhaustive", "partial", "none"]).optional(),
  /**
   * What picks one item out of the container: the fields a caller has
   * to supply, in the order the store keys on them, or a convention
   * the key itself follows (an S3 prefix, a Redis key pattern).
   */
  identifies: z
    .union([
      z.object({ kind: z.literal("keyFields"), fields: z.array(z.string()) }),
      z.object({ kind: z.literal("keyConvention"), pattern: z.string() }),
    ])
    .optional(),
  /** What the store declares an item has, whatever it calls them. */
  fields: z
    .array(
      z.object({
        name: z.string(),
        type: z.string().optional(),
        nullable: z.boolean().optional(),
        primary: z.boolean().optional(),
        unique: z.boolean().optional(),
        /**
         * Set when the boundary serves this field without storing it:
         * a Prisma relation, which is read through its foreign key, or
         * a count the client works out. Nothing writes one, so the
         * unused and write-only checks leave it alone.
         */
        derived: z.boolean().optional(),
        /**
         * The columns of THIS container that a write through this
         * relation sets. A Prisma relation declaring
         * `@relation(fields: [authorId])` owns the foreign key, so
         * connecting a row to it sets `authorId` here. Absent when the
         * key lives on the other side or in a join table, where such a
         * write changes no column of this container.
         */
        relationKey: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  indexes: z
    .array(z.object({ fields: z.array(z.string()), unique: z.boolean() }))
    .optional(),
  /** The physical SQL name when a model maps to a table spelled differently. */
  physicalTable: z.string().optional(),
});

export type StorageContractMetadata = z.infer<
  typeof StorageContractMetadataSchema
>;

/** The fields and indexes a schema declares for one container. */
export function readStorageContractMetadata(
  summary: BehavioralSummary,
): StorageContractMetadata | undefined {
  return readNamespace(
    StorageContractMetadataSchema,
    summary.metadata?.storageContract,
  );
}

/**
 * What one measurement of a metric is. `"number"` is a single value per
 * point, which is what a comparison against a threshold needs.
 * `"histogram"` is buckets, which have no one value, so something has
 * to reduce it before anything can compare it.
 *
 * `"histogram"` is the OpenTelemetry metrics data model's word for the
 * bucketed point kind. Cloud Monitoring calls the same thing
 * DISTRIBUTION, and the pack that reads it translates.
 */
export const MetricValueShapeSchema = z.enum(["number", "histogram"]);

export type MetricValueShape = z.infer<typeof MetricValueShapeSchema>;

/**
 * What one measurement covers: `"gauge"` is the value at a point,
 * `"delta"` the change across the interval before it, and
 * `"cumulative"` the total since the series started.
 *
 * `"delta"` and `"cumulative"` are OpenTelemetry's aggregation
 * temporalities. OpenTelemetry gives an instantaneous measurement no
 * temporality and calls its point kind a gauge instead, and Cloud
 * Monitoring's metric kind spells all three outright: GAUGE, DELTA,
 * CUMULATIVE.
 */
export const MetricAccumulationSchema = z.enum([
  "gauge",
  "delta",
  "cumulative",
]);

export type MetricAccumulation = z.infer<typeof MetricAccumulationSchema>;

const MetricContractMetadataSchema = z.object({
  /** What one measurement is, when the declaring side says. */
  values: MetricValueShapeSchema.optional(),
  /** What one measurement covers, when the declaring side says. */
  accumulates: MetricAccumulationSchema.optional(),
});

export type MetricContractMetadata = z.infer<
  typeof MetricContractMetadataSchema
>;

/** What the side declaring a metric says its measurements are. */
export function readMetricContractMetadata(
  summary: BehavioralSummary,
): MetricContractMetadata | undefined {
  return readNamespace(
    MetricContractMetadataSchema,
    summary.metadata?.metricContract,
  );
}

const MetricReadingMetadataSchema = z.object({
  /** What the reading compares the series against, when it compares. */
  comparesTo: MetricValueShapeSchema.optional(),
  /** What the reading turns each window into first, when it states one. */
  reducesTo: MetricValueShapeSchema.optional(),
  /**
   * The setting this kind of reading states a reduction in, and what
   * each value of it leaves behind. A reader that knows the monitoring
   * system fills these in, so a finding can say which setting to change
   * without the checker knowing the system.
   */
  reduction: z
    .object({
      setting: z.string(),
      leaves: z.record(z.string(), MetricValueShapeSchema),
    })
    .optional(),
});

export type MetricReadingMetadata = z.infer<typeof MetricReadingMetadataSchema>;

/** What the side reading a metric needs from it. */
export function readMetricReadingMetadata(
  summary: BehavioralSummary,
): MetricReadingMetadata | undefined {
  return readNamespace(
    MetricReadingMetadataSchema,
    summary.metadata?.metricReading,
  );
}

const CodeScopeMetadataSchema = z.object({
  kind: z.enum(["codeUri", "unknown"]),
  path: z.string().optional(),
  /** The file the runtime enters, without an extension. */
  entry: z.string().optional(),
});

export type CodeScopeMetadata = z.infer<typeof CodeScopeMetadataSchema>;

/** Which code a deployable unit runs, or the unknown marker when nothing said. */
export function readCodeScopeMetadata(
  summary: BehavioralSummary,
): CodeScopeMetadata | undefined {
  return readNamespace(CodeScopeMetadataSchema, summary.metadata?.codeScope);
}

const ReactMetadataSchema = z.object({
  kind: z.string().optional(),
  deps: z.array(z.string()).nullable().optional(),
  /** The component whose body spawned this sub-unit. */
  component: z.string().optional(),
  /** Which spawn it was in that body, counting from zero. */
  index: z.number().optional(),
});

export type ReactMetadata = z.infer<typeof ReactMetadataSchema>;

/** What the React pack recorded about a sub-unit, an effect and its deps. */
export function readReactMetadata(
  summary: BehavioralSummary,
): ReactMetadata | undefined {
  return readNamespace(ReactMetadataSchema, summary.metadata?.react);
}

const StorybookMetadataSchema = z.object({
  story: z.string().optional(),
  component: z.string().optional(),
  args: z.record(z.string(), z.string()).optional(),
  provenance: z.string().optional(),
});

export type StorybookMetadata = z.infer<typeof StorybookMetadataSchema>;

/** The story a summary describes, and the component it is written for. */
export function readStorybookMetadata(
  summary: BehavioralSummary,
): StorybookMetadata | undefined {
  const component = summary.metadata?.component;
  if (typeof component !== "object" || component === null) {
    return undefined;
  }
  return readNamespace(
    StorybookMetadataSchema,
    (component as { storybook?: unknown }).storybook,
  );
}
