import { describe, expect, it } from "vitest";

import { interactionsOf, packUnderTest } from "@suss/pack-harness";

import { messageSends } from "./messageSends.js";
import { constructedFrom } from "./ops.js";
import { pack } from "./pack.js";

import type { PatternPack } from "@suss/extractor";

// The AWS SDK v3 shape both packs read: one `send`, and the command
// class says which operation it is.
const LIBRARY = {
  "@aws-sdk/client-sqs": `
export class SQSClient {
  constructor(config?: unknown);
  send(command: unknown): Promise<unknown>;
}
export class SendMessageCommand { constructor(input: unknown); }
export class SendMessageBatchCommand { constructor(input: unknown); }
`,
  "@aws-sdk/client-eventbridge": `
export class EventBridgeClient {
  constructor(config?: unknown);
  send(command: unknown): Promise<unknown>;
}
export class PutEventsCommand { constructor(input: unknown); }
`,
};

/** Where a send states its message, one argument into the command. */
const INSIDE_THE_COMMAND = (named: string[], from: string) => ({
  send: {
    input: {
      at: 0,
      of: [
        {
          to: "argument" as const,
          at: 0,
          origin: constructedFrom({ from: [from], named }),
        },
      ],
    },
  },
});

const SQS = "@aws-sdk/client-sqs";
const EVENTBRIDGE = "@aws-sdk/client-eventbridge";

const sqsPack = (): PatternPack =>
  pack(
    "aws-sqs-test",
    [
      messageSends({
        wire: "aws_sqs",
        client: constructedFrom(SQS),
        messages: { each: "theInput" },
        channel: [{ property: "QueueUrl" }],
        body: "MessageBody",
      })
        .methods(INSIDE_THE_COMMAND(["SendMessageCommand"], SQS))
        .example('client.send(new SendMessageCommand({ QueueUrl: "orders" }))'),
      messageSends({
        wire: "aws_sqs",
        client: constructedFrom(SQS),
        messages: { each: "in", property: "Entries" },
        channel: [{ property: "QueueUrl" }],
        body: "MessageBody",
      })
        .methods(INSIDE_THE_COMMAND(["SendMessageBatchCommand"], SQS))
        .example(
          'client.send(new SendMessageBatchCommand({ Entries: [{ QueueUrl: "orders" }] }))',
        ),
    ],
    { languages: ["typescript"], recognizedAs: "@suss/framework-aws-sqs" },
  );

const eventBridgePack = (): PatternPack =>
  pack(
    "aws-eventbridge-test",
    [
      messageSends({
        wire: "eventbridge",
        client: constructedFrom(EVENTBRIDGE),
        messages: { each: "in", property: "Entries" },
        channel: [
          { property: "EventBusName", whenAbsent: "default" },
          { property: "DetailType" },
        ],
        // A subject written where nothing here can read it leaves the
        // send unnamed. A hole in its place would pair across buses.
        unsettledName: "nothing",
        body: "Detail",
      })
        .methods(INSIDE_THE_COMMAND(["PutEventsCommand"], EVENTBRIDGE))
        .example(
          'client.send(new PutEventsCommand({ Entries: [{ DetailType: "OrderPlaced" }] }))',
        ),
    ],
    {
      languages: ["typescript"],
      recognizedAs: "@suss/framework-aws-eventbridge",
    },
  );

const channelsIn = (
  source: string,
  made: () => PatternPack,
): (string | null)[] =>
  interactionsOf(
    packUnderTest(made(), { library: LIBRARY }).effectsIn(source),
    "message-send",
  ).map((effect) => {
    const semantics = effect.binding?.semantics;
    return semantics?.name === "message-bus" ? semantics.channel : null;
  });

describe("a call that sends one message", () => {
  it("reads the channel off the command's input", () => {
    expect(
      channelsIn(
        `import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
         const client = new SQSClient({});
         export async function send() {
           await client.send(new SendMessageCommand({
             QueueUrl: "orders", MessageBody: "{}",
           }));
         }`,
        sqsPack,
      ),
    ).toEqual(["orders"]);
  });
});

describe("a call that sends many", () => {
  it("records one message per entry", () => {
    expect(
      channelsIn(
        `import { SQSClient, SendMessageBatchCommand } from "@aws-sdk/client-sqs";
         const client = new SQSClient({});
         export async function send() {
           await client.send(new SendMessageBatchCommand({
             Entries: [{ QueueUrl: "orders" }, { QueueUrl: "invoices" }],
           }));
         }`,
        sqsPack,
      ),
    ).toEqual(["orders", "invoices"]);
  });

  it("joins the parts of a channel written in more than one place", () => {
    expect(
      channelsIn(
        `import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
         const client = new EventBridgeClient({});
         export async function send() {
           await client.send(new PutEventsCommand({
             Entries: [{ EventBusName: "orders", DetailType: "OrderPlaced" }],
           }));
         }`,
        eventBridgePack,
      ),
    ).toEqual(["orders#OrderPlaced"]);
  });

  it("uses what the library uses when a part is left out", () => {
    expect(
      channelsIn(
        `import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
         const client = new EventBridgeClient({});
         export async function send() {
           await client.send(new PutEventsCommand({
             Entries: [{ DetailType: "OrderPlaced" }],
           }));
         }`,
        eventBridgePack,
      ),
    ).toEqual(["default#OrderPlaced"]);
  });

  it("names no channel when a part is written somewhere this cannot read", () => {
    // The send happened, so it is recorded. Naming it by half of itself
    // would pair it across buses.
    expect(
      channelsIn(
        `import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
         const client = new EventBridgeClient({});
         export async function send(kind: string) {
           await client.send(new PutEventsCommand({
             Entries: [{ EventBusName: "orders", DetailType: kind }],
           }));
         }`,
        eventBridgePack,
      ),
    ).toEqual([null]);
  });
});

describe("a channel the code names rather than writes out", () => {
  it("keeps the reference, since a queue only exists at deploy time", () => {
    // The URL is not in the source and never will be. What both sides
    // of the boundary agree on is the variable, so the send records a
    // reference to it rather than nothing.
    expect(
      channelsIn(
        `import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
         const client = new SQSClient({});
         export async function send() {
           await client.send(new SendMessageCommand({
             QueueUrl: process.env.ORDERS_QUEUE_URL, MessageBody: "{}",
           }));
         }`,
        sqsPack,
      ),
    ).toEqual(["{ORDERS_QUEUE_URL}"]);
  });
});

describe("telling two commands apart", () => {
  it("reads a single send as one message, not as a batch", () => {
    // Both commands come from the one module and go through the one
    // `send`, so without the command class the two declarations would
    // both match and the batch would be read as a single.
    expect(
      channelsIn(
        `import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
         const client = new SQSClient({});
         export async function send() {
           await client.send(new SendMessageCommand({ QueueUrl: "orders" }));
         }`,
        sqsPack,
      ),
    ).toEqual(["orders"]);
  });
});
