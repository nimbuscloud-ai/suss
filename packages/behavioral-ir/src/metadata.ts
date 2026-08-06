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
