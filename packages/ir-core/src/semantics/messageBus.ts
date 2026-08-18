/**
 * A message bus (SQS, SNS, S3, EventBridge, BullMQ, Kafka, NATS,
 * Cloudflare Queues) as a boundary. A trigger that delivers events
 * nobody published is here too: a Cloudflare cron trigger and a tail
 * Worker each receive on a wire with no producer, the same way an
 * EventBridge schedule does.
 *
 * Producers send to a channel and consumers receive from it. What goes
 * in the channel string depends on the bus. SQS keys it on the one
 * queue identity, either the CFN logical id or the env-var name.
 * EventBridge needs two parts, the event bus and the DetailType a rule
 * matches, written as `"<bus>#<detailType>"`, because one bus carries
 * many event types and a rule subscribes to only some of them. How that
 * string is split, and when two of them agree, is in `channel.ts` next
 * door.
 */

import { z } from "zod";

import { channelsPair, parseChannel } from "../channel.js";
import { busIdentityKey } from "../identityKeys.js";
import { defineBoundarySemantics } from "./definition.js";

export const MessageBusSemanticsSchema = z.object({
  name: z.literal("message-bus"),
  messageBus: z.enum([
    // The conventions spell the two AWS buses this way, one with an
    // underscore and one with a dot, so these are their strings and
    // not a typo.
    "aws_sqs",
    "aws.sns",
    "s3",
    "eventbridge",
    "bullmq",
    "kafka",
    "nats",
    "cloudflare-queues",
    "cloudflare-cron",
    "cloudflare-tail",
  ]),
  /**
   * Stable channel identifier: a CFN logical id, a queue or topic name,
   * a subject pattern, or `bus#detailType`. Null when this source does
   * not say which channel, as with a send whose queue the code picks at
   * runtime, or a receive whose queue the event-source mapping states.
   */
  channel: z.string().min(1).nullable(),
});

export type MessageBusSemantics = z.infer<typeof MessageBusSemanticsSchema>;

/**
 * The bus technologies the schema allows. It comes from the enum, so a
 * value added there cannot drift from a hand-written copy elsewhere.
 */
export type MessageBusTechnology = MessageBusSemantics["messageBus"];

export const messageBusSemantics = defineBoundarySemantics({
  name: "message-bus",
  schema: MessageBusSemanticsSchema,
  behavior: {
    /** A message goes onto the channel and nothing comes back. */
    exchangesHttpResponses: false,
    /**
     * `checkMessageBus` looks at every channel, including the unused
     * ones, so the generic unmatched lists leave them alone.
     */
    reportsUnpairedItself: true,
    /**
     * A channel unnamed here can still pair: the dedicated pass
     * collapses env chains before comparing, so a consumer whose
     * channel arrives at runtime meets the template that declares it.
     */
    canPair: () => true,
    /**
     * `"bus:<messageBus> <subject>"`, or null when the channel is null
     * or its subject is empty.
     *
     * The key has the subject in it and leaves out the bus, so a
     * template writing `default#order.placed` and a handler writing
     * `order.placed` land in one bucket, where `sidesAgree` compares the
     * buses. A side that cannot know its bus would otherwise be keyed
     * away from the side that can.
     *
     * The bus technology stays in, because a queue and an event router
     * are different destinations even with the same subject. Case stays
     * too, because AWS compares detail-types and queue ids byte for byte.
     */
    identityKey(semantics) {
      if (semantics.channel === null) {
        return null;
      }
      const { subject } = parseChannel(semantics.channel);
      if (subject === "") {
        return null;
      }
      return busIdentityKey(semantics.messageBus, subject);
    },
    sidesAgree(a, b) {
      if (a.channel === null || b.channel === null) {
        return false;
      }
      return channelsPair(a.channel, b.channel);
    },
    /**
     * The whole channel, bus included, unlike the identity key, which
     * has the subject alone. Someone reading a list of unmatched
     * channels wants to see which bus each one was on.
     */
    displayLabel(semantics) {
      if (semantics.channel === null) {
        return `bus:${semantics.messageBus} (channel named at runtime)`;
      }
      return `bus:${semantics.messageBus} ${semantics.channel}`;
    },
  },
});
