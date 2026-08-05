// metadata.ts: the typed namespaces inside a summary's metadata bag.
//
// A namespace is a claim two parties share: a contract reader writes
// it and a checker or renderer reads it back. Both sides import the
// schema here, so a renamed field is a compile error at both ends. It
// used to be a convention: eight writers and nine readers hand-cast
// the same shapes, and a renamed key made findings evaporate with no
// error anywhere.
//
// Reads validate. An entry that does not parse answers undefined, the
// same answer as an absent entry, so artifacts written before a
// namespace changed keep reading instead of crashing.

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

/** The summary's message-bus namespace, or undefined when absent or unreadable. */
export function readMessageBusMetadata(
  summary: BehavioralSummary,
): MessageBusMetadata | undefined {
  const raw = summary.metadata?.messageBus;
  if (raw === undefined) {
    return undefined;
  }
  const parsed = MessageBusMetadataSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}
