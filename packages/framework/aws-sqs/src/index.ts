/**
 * Recognizes AWS SQS sends, and the `JSON.parse(record.body)` read in an
 * SQS handler, and records a `message-send` or `message-receive` effect
 * for each so the two sides pair.
 *
 * Only AWS SDK v3 is read. A handler gets its queue binding from
 * `@suss/contract-cloudformation`. The README explains how the queue is
 * identified from `QueueUrl` and how a project declares its own
 * dispatcher in a dependency stub.
 */

import { z } from "zod";

import { configuredCallOption } from "@suss/extractor";
import {
  configuredSends,
  constructedFrom,
  messageReceives,
  messageSends,
  pack,
  typed,
} from "@suss/recognize";

import type { PatternPack } from "@suss/extractor";
import type { PackDeclaration } from "@suss/ir-core";
import type { ConfiguredCallSpec, Match } from "@suss/recognize";

const SQS = "@aws-sdk/client-sqs";

/**
 * The message is the first argument to the command's constructor, and
 * the command is the first argument to `send`.
 */
const INSIDE_THE_COMMAND = (named: string[]) => ({
  send: {
    input: {
      at: 0,
      of: [
        {
          to: "argument" as const,
          at: 0,
          origin: constructedFrom({ from: [SQS], named }),
        },
      ],
    },
  },
});

function sendDeclarations(): Match[] {
  return [
    messageSends({
      wire: "aws_sqs",
      client: constructedFrom(SQS),
      messages: { each: "theInput" },
      channel: [{ property: ["QueueUrl"] }],
      body: "MessageBody",
    })
      .methods(INSIDE_THE_COMMAND(["SendMessageCommand"]))
      .example(
        'client.send(new SendMessageCommand({ QueueUrl: "orders", MessageBody: "{}" }))',
      ),
    messageSends({
      wire: "aws_sqs",
      client: constructedFrom(SQS),
      messages: { each: "in", property: "Entries" },
      // The queue is on the command input, once, beside the list of messages.
      channel: [{ property: ["QueueUrl"], on: "theInput" }],
      body: "MessageBody",
    })
      .methods(INSIDE_THE_COMMAND(["SendMessageBatchCommand"]))
      .example(
        'client.send(new SendMessageBatchCommand({ QueueUrl: "orders", Entries: [{ MessageBody: "{}" }] }))',
      ),
  ];
}

/**
 * A Lambda handler is handed a batch of records, each with the message
 * the producer wrote as JSON in its `body`. The record is an element of
 * the event's `Records`, or a value the program types as one.
 */
function receiveDeclaration(): Match {
  return messageReceives({
    wire: "aws_sqs",
    codec: "json",
    envelope: [
      { path: [{ read: "Records" }, { each: true }, { read: "body" }] },
      {
        from: typed({ from: ["aws-lambda"], named: ["SQSRecord"] }),
        path: [{ read: "body" }],
      },
    ],
  }).example(
    "for (const record of event.Records) { const { id } = JSON.parse(record.body); }",
  );
}

/**
 * A send through a project's own dispatcher, a method on it or a function
 * its package exports. A service that wraps the SDK never writes
 * `SendMessageCommand`, so the SDK declaration never matches its sends.
 */
export type SqsProducer = ConfiguredCallSpec;

/**
 * A dependency stub fills `producers`, and the CLI refuses a config file
 * that sets it.
 */
export const optionsSchema = z
  .object({
    /**
     * Each dispatcher adds the declarations for its sends, and the pack
     * also reads files that import the dispatcher's module.
     */
    producers: z.array(configuredCallOption).optional(),
  })
  .strict();

export type SqsPackOptions = z.infer<typeof optionsSchema>;

/**
 * Reads SDK sends, handler reads of `record.body`, and sends through
 * each configured dispatcher. A dispatcher's channel is the subject it
 * is passed, which is what the consumer expects too.
 */
export function sqsFramework(options: SqsPackOptions = {}): PatternPack {
  const producers = (options.producers ?? []).flatMap((producer) =>
    configuredSends(producer, "aws_sqs"),
  );
  return pack(
    "sqs",
    [...sendDeclarations(), ...producers, receiveDeclaration()],
    {
      languages: ["typescript", "javascript"],
      recognizedAs: "@suss/framework-aws-sqs",
      version: "1",
      protocol: "sqs",
      // A handler file imports `SQSEvent` from aws-lambda and often never
      // imports the SQS client.
      requiresImport: ["aws-lambda"],
      // A handler that types its event in place imports neither, and what
      // it spells to read a message is what admits its file.
      requiresText: ["Records", "JSON.parse"],
    },
  );
}

export const declares: PackDeclaration = {
  kind: "effects",
  package: "@suss/framework-aws-sqs",
  dependencies: [{ ecosystem: "npm", name: "@aws-sdk/client-sqs" }],
  reads:
    "AWS SDK v3 SQS producer calls. Each one becomes a message-send interaction.",
};

export default sqsFramework;
