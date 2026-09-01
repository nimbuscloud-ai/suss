/**
 * Recognize AWS SNS publish calls and emit `message-send` effects.
 *
 * The anchor is the command, the way it is for every AWS SDK v3 client:
 * the method is `send` at every call site and the command class says
 * which operation it is. `PublishCommand` carries one message and
 * `PublishBatchCommand` carries a list of them beside one topic, so
 * they are two declarations rather than one with a setting on it.
 *
 * A publish writes its destination as `TopicArn` or as `TargetArn`, and
 * a `PhoneNumber` publish reaches a handset that nothing subscribes to.
 * The README beside this file says how a channel comes to be named.
 */

import { constructedFrom, messageSends, pack } from "@suss/recognize";

import type { Match, MessageSendMethod, PatternPack } from "@suss/recognize";

/** The module a command class comes from. */
const SNS = "@aws-sdk/client-sns";

/** Where a publish states its message: one argument into the command. */
const INSIDE_THE_COMMAND = (
  named: string[],
): Record<string, MessageSendMethod> => ({
  send: {
    input: {
      at: 0,
      of: [
        {
          to: "argument" as const,
          at: 0,
          origin: constructedFrom({ from: [SNS], named }),
        },
      ],
    },
  },
});

/**
 * Which topic a publish reached. `TargetArn` is the same destination
 * under another name, so a message that writes either one says where it
 * went.
 */
const TOPIC = ["TopicArn", "TargetArn"];

/**
 * One publish, and the batch form.
 *
 * `Subject` rides along as the routing key. It scopes the message for
 * somebody reading the summary, the way EventBridge's `Source` does,
 * and it stays out of the channel, because a subscription filters on
 * the message rather than on the subject line.
 */
const PUBLISH: Match = messageSends({
  wire: "aws.sns",
  client: constructedFrom(SNS),
  messages: { each: "theInput" },
  channel: [{ property: TOPIC }],
  routingKey: "Subject",
  body: "Message",
})
  .methods(INSIDE_THE_COMMAND(["PublishCommand"]))
  .example(
    'client.send(new PublishCommand({ TopicArn: "orders", Message: "{}" }))',
  );

const PUBLISH_BATCH: Match = messageSends({
  wire: "aws.sns",
  client: constructedFrom(SNS),
  messages: { each: "in", property: "PublishBatchRequestEntries" },
  // A batch states the topic once beside the list of messages.
  channel: [{ property: TOPIC, on: "theInput" }],
  routingKey: "Subject",
  body: "Message",
})
  .methods(INSIDE_THE_COMMAND(["PublishBatchCommand"]))
  .example(
    'client.send(new PublishBatchCommand({ TopicArn: "orders", PublishBatchRequestEntries: [{ Id: "1", Message: "{}" }] }))',
  );

/**
 * Pack export. Two declarations, gated on a file importing the SNS
 * client, which is where a command class can come from.
 */
export function snsFramework(): PatternPack {
  return pack("aws-sns", [PUBLISH, PUBLISH_BATCH], {
    languages: ["typescript", "javascript"],
    recognizedAs: "@suss/framework-aws-sns",
    protocol: "sns",
  });
}

export default snsFramework;
