// @suss/framework-aws-eventbridge: recognize AWS EventBridge
// producer-side calls in TypeScript and emit one
// `interaction(class: "message-send")` effect per PutEvents entry.
//
// Producer-side recognition only. Consumer-side target Lambdas gain
// their message-bus boundaryBinding via the contract-source pass that
// walks CFN/SAM `AWS::Events::Rule` + `Events:{Type: EventBridgeRule |
// Schedule}` blocks (lives in @suss/contract-cloudformation, not this
// package). There is no consumer-side body recognizer here yet: an
// EventBridge target handler reads `event.detail`, which a follow-up
// message-receive recognizer can extract; until then body-shape pairing
// isn't available for EventBridge (orphan / unused / unresolvable /
// schedule accounting still work off the CFN summaries).
//
// AWS SDK v3 (modular) only for v0:
//
//   import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
//   const client = new EventBridgeClient({});
//   await client.send(new PutEventsCommand({
//     Entries: [{
//       EventBusName: process.env.ORDER_EVENT_BUS_NAME,
//       Source: "orders.service",
//       DetailType: "OrderPlaced",
//       Detail: JSON.stringify(order),
//     }],
//   }));
//
// AWS SDK v2 (`new AWS.EventBridge().putEvents(...).promise()`) is a
// follow-up: the surface is similar but the call shape differs.
//
// A service that publishes through its own EventPublisher writes no
// PutEventsCommand of its own, so the SDK declaration never fires on
// it. Such a project says which publisher in the pack's `producers`
// option:
//
//   { module: "@acme/async", receiver: "EventPublisher",
//     method: "emit", subjectArg: 0, bodyArg: 1 }
//
// which reads `publisher.emit("user.deleted", data, opts)` as a send on
// channel "user.deleted". A subject the source does not state as a
// string yields no effect.
//
// CHANNEL IDENTITY SCHEME
// -----------------------
// One event bus multiplexes many event types, and a rule subscribes to
// a subset of them keyed by DetailType, so the channel is both parts:
//
//     channel = `${bus}#${detailType}`
//
// The bus is nearly always deploy-named, so the code writes
// `process.env.ORDER_EVENT_BUS_NAME` and the declaration keeps the
// reference: `{ORDER_EVENT_BUS_NAME}#OrderPlaced`. The message-bus
// checker resolves the reference to the CFN EventBus logical id via the
// producer Lambda's Environment block. A bus written nowhere at all is
// the account's default bus, which is what `whenAbsent` states. A
// DetailType decided at run time leaves the channel null, because a
// channel spelled by half of itself would pair across buses.
//
// The `Source` field scopes an event on the bus but does not key
// pairing in v0, so it rides as the routing key for a reader.

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
import type { CallExpression } from "ts-morph";

const EVENTBRIDGE = "@aws-sdk/client-eventbridge";

export type EventBridgeProducer = ConfiguredCallSpec;

/**
 * What this pack's options may say. The CLI parses a
 * `-f aws-eventbridge=config.json` file against it, minus the keys a dependency
 * stub fills, which a config file may not set.
 */
export const optionsSchema = z
  .object({
    /**
     * Publishers this project emits through. Each one adds a recognizer
     * and widens the import gate to that publisher's module.
     */
    producers: z.array(configuredCallOption).optional(),
  })
  .strict();

export type EventBridgePackOptions = z.infer<typeof optionsSchema>;

/**
 * One recognizer per configured publisher method. The subject the
 * call states is the channel, with no bus segment: a publisher takes
 * its bus from constructor config the call site never states, and the
 * checker treats an unstated bus as agreeing with any, so the subject
 * alone pairs against the rule that routes it.
 *
 * Stays a function recognizer because a channel that is the argument
 * itself, rather than a property of a message, is not a shape the
 * message-send ending says yet.
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

export default eventBridgeFramework;
