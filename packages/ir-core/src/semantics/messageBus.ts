// messageBus.ts: a message bus (SQS, EventBridge, BullMQ, Kafka,
// NATS) as a boundary.
//
// Producers send to a channel, consumers receive from it. The channel
// string is per-bus: SQS keys it on the single queue identity (CFN
// logical id / env-var name); EventBridge carries a two-part identity,
// the event bus AND the DetailType a rule matches, encoded as
// `"<bus>#<detailType>"`, because one bus multiplexes many event types
// and a rule subscribes to a subset. The split and the agreement rule
// live in `channel.ts` next door.

import { z } from "zod";

import { channelsPair, parseChannel } from "../channel.js";
import { defineBoundarySemantics } from "./definition.js";

export const MessageBusSemanticsSchema = z.object({
  name: z.literal("message-bus"),
  messageBus: z.enum(["sqs", "eventbridge", "bullmq", "kafka", "nats"]),
  /**
   * Stable channel identifier — CFN logical id, queue/topic name,
   * subject pattern, `bus#detailType`. Null when this source does not
   * name the channel: a send whose queue the code names at runtime,
   * or a receive whose queue the event-source mapping states.
   */
  channel: z.string().min(1).nullable(),
});

export type MessageBusSemantics = z.infer<typeof MessageBusSemanticsSchema>;

export const messageBusSemantics = defineBoundarySemantics({
  name: "message-bus",
  schema: MessageBusSemanticsSchema,
  behavior: {
    /**
     * `"bus:<messageBus> <subject>"`; null when the channel is null
     * or its subject empty.
     *
     * The key carries the subject and drops the bus, so a template
     * that writes `default#order.placed` and a handler that writes
     * `order.placed` land in one bucket, and `sidesAgree` compares
     * the buses inside it; a side that cannot know its bus would
     * otherwise be keyed away from the side that can.
     *
     * The bus technology stays in the key the way the HTTP method
     * stays in a REST key. A queue and an event router are different
     * destinations even when they carry the same subject name.
     *
     * Subjects keep their case. Detail-types and queue logical ids
     * are compared byte for byte by AWS, so folding case here would
     * pair two channels that never reach each other.
     */
    identityKey(semantics) {
      if (semantics.channel === null) {
        return null;
      }
      const { subject } = parseChannel(semantics.channel);
      if (subject === "") {
        return null;
      }
      return `bus:${semantics.messageBus} ${subject}`;
    },
    sidesAgree(a, b) {
      if (a.channel === null || b.channel === null) {
        return false;
      }
      return channelsPair(a.channel, b.channel);
    },
  },
});
