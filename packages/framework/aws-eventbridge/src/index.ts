/**
 * Recognizes AWS EventBridge `PutEvents` calls and records one
 * `message-send` effect per entry, on the channel `${bus}#${detailType}`.
 *
 * Only the producer side and AWS SDK v3 are read here. A target Lambda
 * gets its binding from `@suss/contract-cloudformation`, and nothing reads
 * `event.detail` in a handler yet, so message bodies are not compared.
 * The README explains the channel and how a project declares its own
 * publisher in a dependency stub.
 */

import { z } from "zod";

import { readConfiguredCall } from "@suss/adapter-typescript";
import { messageBusBinding } from "@suss/behavioral-ir";
import { configuredCallOption } from "@suss/extractor";
import { constructedFrom, messageSends, pack } from "@suss/recognize";

import type {
  ConfiguredCallContext,
  ConfiguredCallSpec,
} from "@suss/adapter-typescript";
import type { Effect } from "@suss/behavioral-ir";
import type { InvocationRecognizer, PatternPack } from "@suss/extractor";
import type { PackDeclaration } from "@suss/ir-core";
import type { CallExpression } from "ts-morph";

const EVENTBRIDGE = "@aws-sdk/client-eventbridge";

export type EventBridgeProducer = ConfiguredCallSpec;

/**
 * A dependency stub fills `producers`, and the CLI refuses a config file
 * that sets it.
 */
export const optionsSchema = z
  .object({
    /**
     * Each publisher adds a recognizer, and the pack also reads files that
     * import the publisher's module.
     */
    producers: z.array(configuredCallOption).optional(),
  })
  .strict();

export type EventBridgePackOptions = z.infer<typeof optionsSchema>;

/**
 * The channel is the subject the call passes, with no bus part. A
 * publisher takes its bus from constructor config that the call site
 * never shows, and the checker treats a missing bus as matching any bus,
 * so the subject alone pairs with the rule that routes it.
 *
 * This recognizer is written by hand because the message-send ending
 * reads a channel only from a property of a message, and here the
 * channel is a bare argument.
 */
function configuredProducerRecognizer(
  spec: ConfiguredCallSpec,
): InvocationRecognizer {
  return ((call: unknown, ctx: unknown): Effect[] | null => {
    const read = readConfiguredCall(
      call as CallExpression,
      ctx as ConfiguredCallContext,
      spec,
    );
    if (read === null) {
      return null;
    }
    return [
      {
        type: "interaction",
        binding: messageBusBinding({
          recognition: "@suss/framework-aws-eventbridge",
          messageBus: "eventbridge",
          channel: read.subject,
        }),
        callee: read.callee,
        interaction: {
          class: "message-send",
          ...(read.body !== null ? { body: read.body } : {}),
        },
      },
    ];
  }) as InvocationRecognizer;
}

export function eventBridgeFramework(
  options: EventBridgePackOptions = {},
): PatternPack {
  const producers = options.producers ?? [];
  return pack(
    "eventbridge",
    [
      messageSends({
        wire: "eventbridge",
        client: constructedFrom(EVENTBRIDGE),
        messages: { each: "in", property: "Entries" },
        channel: [
          {
            property: ["EventBusName"],
            whenAbsent: "default",
            unsettled: "reference",
          },
          { property: ["DetailType"], unsettled: "nothing" },
        ],
        unsettledName: "nothing",
        routingKey: "Source",
        body: "Detail",
      })
        .methods({
          send: {
            input: {
              at: 0,
              of: [
                {
                  to: "argument",
                  at: 0,
                  origin: constructedFrom({
                    from: [EVENTBRIDGE],
                    named: ["PutEventsCommand"],
                  }),
                },
              ],
            },
          },
        })
        .example(
          'client.send(new PutEventsCommand({ Entries: [{ DetailType: "OrderPlaced", Detail: "{}" }] }))',
        ),
    ],
    {
      languages: ["typescript", "javascript"],
      recognizedAs: "@suss/framework-aws-eventbridge",
      protocol: "eventbridge",
      requiresImport: producers.map((p) => p.module),
      recognizers: producers.map(configuredProducerRecognizer),
    },
  );
}

export const declares: PackDeclaration = {
  kind: "effects",
  package: "@suss/framework-aws-eventbridge",
  dependencies: [{ ecosystem: "npm", name: "@aws-sdk/client-eventbridge" }],
  reads:
    "AWS EventBridge \`PutEvents\` producer calls. Each one becomes a message-bus interaction.",
};

export default eventBridgeFramework;
