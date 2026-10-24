/**
 * A message bus, such as SQS or Kafka, as a boundary. A trigger that
 * delivers events nobody published is here too: a Cloudflare cron
 * trigger and a tail Worker receive on a wire with no producer, as an
 * EventBridge schedule does.
 *
 * Producers send to a channel and consumers receive from it. What goes
 * in the channel string depends on the bus. For SQS it is the one queue
 * identity, either the CloudFormation logical id or the environment
 * variable name. EventBridge needs two parts, the event bus and the
 * DetailType a rule matches, written `<bus>#<detailType>`, because one
 * bus has many event types and a rule subscribes to only some of them.
 * The channel module splits that string and compares two of them.
 */

import { z } from "zod";

import { channelsPair, parseChannel } from "../channel.js";
import { busIdentityKey } from "../identityKeys.js";
import { defineBoundarySemantics } from "./definition.js";

export const MessageBusSemanticsSchema = z.object({
  name: z.literal("message-bus"),
  messageBus: z.enum([
    // The conventions write these two AWS buses differently, one with an
    // underscore and one with a dot. Both are as the conventions give them.
    "aws_sqs",
    "aws.sns",
    "s3",
    "eventbridge",
    // A Kinesis stream and a Firehose delivery stream are different
    // APIs with different destinations, so a stream named `orders` and
    // a delivery stream named `orders` are not the same channel.
    "aws_kinesis",
    "aws_firehose",
    "gcp_pubsub",
    // Job queues. The header says what their channel is.
    "bullmq",
    "activejob",
    "sidekiq",
    "celery",
    "kafka",
    "nats",
    "cloudflare-queues",
    "cloudflare-cron",
    "cloudflare-tail",
  ]),
  /**
   * A stable channel identifier: a CloudFormation logical id, a queue or
   * topic name, a subject pattern, or `bus#detailType`. Null when this
   * source does not say which channel, as with a send whose queue the
   * code picks at run time, or a receive whose queue is set in the
   * event-source mapping.
   */
  channel: z.string().min(1).nullable(),
});

export type MessageBusSemantics = z.infer<typeof MessageBusSemanticsSchema>;

/**
 * The bus technologies the schema allows. It is derived from the enum,
 * so there is no hand-written copy to fall out of step.
 */
export type MessageBusTechnology = MessageBusSemantics["messageBus"];

/** What a bus is like, where the checks treat one bus differently from another. */
export interface MessageBusTraits {
  /** The bus is a background job queue, so a send whose job is unsettled leaves a gap. */
  jobQueue: boolean;
  /**
   * A scheduler can put work on the bus from a config file the run does
   * not read, as `sidekiq.yml` and Celery beat do, so a consumer with no
   * producer in code may still run.
   */
  scheduledFromConfig: boolean;
}

const MESSAGES: MessageBusTraits = {
  jobQueue: false,
  scheduledFromConfig: false,
};
const JOBS: MessageBusTraits = { jobQueue: true, scheduledFromConfig: false };
const SCHEDULED_JOBS: MessageBusTraits = {
  jobQueue: true,
  scheduledFromConfig: true,
};

export const MESSAGE_BUS_TRAITS: Record<
  MessageBusTechnology,
  MessageBusTraits
> = {
  aws_sqs: MESSAGES,
  "aws.sns": MESSAGES,
  s3: MESSAGES,
  eventbridge: MESSAGES,
  aws_kinesis: MESSAGES,
  aws_firehose: MESSAGES,
  gcp_pubsub: MESSAGES,
  bullmq: JOBS,
  activejob: SCHEDULED_JOBS,
  sidekiq: SCHEDULED_JOBS,
  celery: SCHEDULED_JOBS,
  kafka: MESSAGES,
  nats: MESSAGES,
  "cloudflare-queues": MESSAGES,
  "cloudflare-cron": MESSAGES,
  "cloudflare-tail": MESSAGES,
};

export const messageBusSemantics = defineBoundarySemantics({
  name: "message-bus",
  schema: MessageBusSemanticsSchema,
  semconv: {
    messageBus: { name: "messaging.system" },
    channel: { name: "messaging.destination.name" },
  },
  behavior: {
    /** A message goes onto the channel and nothing comes back. */
    exchangesHttpResponses: false,
    leavesTheProcess: true,
    /**
     * `checkMessageBus` reports every channel, unused ones included, so
     * the generic unmatched list leaves them out.
     */
    reportsUnpairedItself: true,
    consumedAs: ["reads"],
    unsettledJob: (semantics) =>
      semantics.channel === null &&
      MESSAGE_BUS_TRAITS[semantics.messageBus].jobQueue,
    /**
     * A channel that is null here can still pair. The dedicated pass
     * follows environment variable chains before comparing, so a
     * consumer whose channel is set at run time meets the template that
     * declares it.
     */
    canPair: () => true,
    /**
     * `"bus:<messageBus> <subject>"`, or null when the channel is null
     * or its subject is empty.
     *
     * The key has the subject and leaves out the bus, so a template
     * writing `default#order.placed` and a handler writing
     * `order.placed` land in one bucket, where `sidesAgree` compares the
     * buses. Keying on the bus would separate a side that cannot know
     * its bus from the side that can.
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
     * The whole channel, bus included, where the identity key has only
     * the subject. A reader looking at unmatched channels needs to see
     * which bus each one was on.
     */
    displayLabel(semantics) {
      if (semantics.channel === null) {
        return `bus:${semantics.messageBus} (channel named at runtime)`;
      }
      return `bus:${semantics.messageBus} ${semantics.channel}`;
    },
  },
});
