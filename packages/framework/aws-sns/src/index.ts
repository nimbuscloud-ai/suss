/**
 * Recognizes AWS SNS publish calls and records each message as a
 * `message-send` effect on the topic.
 *
 * `PublishCommand` sends one message. `PublishBatchCommand` sends a list
 * of them and gives the topic once, beside the list, so the two commands
 * need separate declarations. The README explains how a topic ARN held in
 * an env var becomes the channel.
 */

import { constructedFrom, messageSends, pack } from "@suss/recognize";

import type { PackDeclaration } from "@suss/ir-core";
import type { Match, MessageSendMethod, PatternPack } from "@suss/recognize";

const SNS = "@aws-sdk/client-sns";

/**
 * The message is the first argument to the command's constructor, and
 * the command is the first argument to `send`.
 */
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

/** `TargetArn` is the same destination as `TopicArn` under another name. */
const TOPIC = ["TopicArn", "TargetArn"];

/**
 * `Subject` is recorded as the routing key, the way EventBridge's
 * `Source` is, so a reader of the summary can tell messages apart. It is
 * kept out of the channel because a subscription cannot filter on it.
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
  // The topic is on the command input, once, beside the list of messages.
  channel: [{ property: TOPIC, on: "theInput" }],
  routingKey: "Subject",
  body: "Message",
})
  .methods(INSIDE_THE_COMMAND(["PublishBatchCommand"]))
  .example(
    'client.send(new PublishBatchCommand({ TopicArn: "orders", PublishBatchRequestEntries: [{ Id: "1", Message: "{}" }] }))',
  );

/**
 * A command counts only when its class is imported from the SNS client,
 * so a class with the same name from another module is ignored.
 */
export function snsFramework(): PatternPack {
  return pack("aws-sns", [PUBLISH, PUBLISH_BATCH], {
    languages: ["typescript", "javascript"],
    recognizedAs: "@suss/framework-aws-sns",
    protocol: "sns",
  });
}

export const declares: PackDeclaration = {
  kind: "effects",
  package: "@suss/framework-aws-sns",
  dependencies: [{ ecosystem: "npm", name: "@aws-sdk/client-sns" }],
  reads:
    "AWS SDK v3 SNS \`Publish\` and \`PublishBatch\` calls. Each one becomes a message-send interaction on the topic.",
};

export default snsFramework;
