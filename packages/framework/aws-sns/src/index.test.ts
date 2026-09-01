import { describe, expect, it } from "vitest";

import { interactionsOf, packUnderTest } from "@suss/pack-harness";

import { snsFramework } from "./index.js";

import type { Effect } from "@suss/behavioral-ir";

const raise = (msg: string): never => {
  throw new Error(msg);
};

// The recognizer walks an import back to the module that declared it,
// so every module a fixture imports has to be on disk.
const SNS_TYPES = `
export class SNSClient {
  constructor(config?: unknown);
  send(command: unknown): Promise<unknown>;
}
export class PublishCommand {
  constructor(input: {
    TopicArn?: string;
    TargetArn?: string;
    PhoneNumber?: string;
    Subject?: string;
    Message?: string;
  });
}
export class PublishBatchCommand {
  constructor(input: { TopicArn?: string; PublishBatchRequestEntries?: unknown[] });
}
`;

const LIBRARY = { "@aws-sdk/client-sns": SNS_TYPES };

const publishesIn = (source: string) =>
  interactionsOf(
    packUnderTest(snsFramework(), { library: LIBRARY }).effectsIn(source),
    "message-send",
  );

const channelOf = (effect: Effect): string | null => {
  if (effect.type !== "interaction") {
    return raise("not an interaction");
  }
  const semantics = effect.binding.semantics;
  return semantics.name === "message-bus" ? semantics.channel : null;
};

describe("sns publish", () => {
  it("emits one message-send for a publish, keeping the env var name as the channel", () => {
    const publishes = publishesIn(`
      import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
      const sns = new SNSClient({});
      async function announce(order: { id: string }) {
        await sns.send(new PublishCommand({
          TopicArn: process.env.ORDER_EVENTS_TOPIC_ARN,
          Message: JSON.stringify(order),
        }));
      }
    `);
    expect(publishes).toHaveLength(1);
    const publish = publishes[0] ?? raise("no publish");
    expect(publish.binding.transport).toBe("aws.sns");
    expect(publish.binding.semantics).toMatchObject({
      name: "message-bus",
      messageBus: "aws.sns",
      channel: "{ORDER_EVENTS_TOPIC_ARN}",
    });
  });

  it("records the Message as the body, so a consumer's field set pairs against it", () => {
    const publish =
      publishesIn(`
      import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
      const sns = new SNSClient({});
      async function announce(order: { id: string; total: number }) {
        await sns.send(new PublishCommand({
          TopicArn: process.env.ORDER_EVENTS_TOPIC_ARN,
          Message: JSON.stringify({ id: order.id, total: order.total }),
        }));
      }
    `)[0] ?? raise("no publish");
    expect(publish.interaction).toMatchObject({
      class: "message-send",
      body: { kind: "object", fields: { id: expect.anything() } },
    });
  });

  it("carries the Subject as the routing key without putting it in the channel", () => {
    const publish =
      publishesIn(`
      import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
      const sns = new SNSClient({});
      async function announce() {
        await sns.send(new PublishCommand({
          TopicArn: process.env.ORDER_EVENTS_TOPIC_ARN,
          Subject: "OrderPlaced",
          Message: "{}",
        }));
      }
    `)[0] ?? raise("no publish");
    expect(publish.interaction).toMatchObject({ routingKey: "OrderPlaced" });
    expect(channelOf(publish)).toBe("{ORDER_EVENTS_TOPIC_ARN}");
  });

  it("reads a TargetArn as the same part of the channel a TopicArn names", () => {
    const publish =
      publishesIn(`
      import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
      const sns = new SNSClient({});
      async function announce() {
        await sns.send(new PublishCommand({
          TargetArn: process.env.ORDER_EVENTS_TOPIC_ARN,
          Message: "{}",
        }));
      }
    `)[0] ?? raise("no publish");
    expect(channelOf(publish)).toBe("{ORDER_EVENTS_TOPIC_ARN}");
  });

  it("leaves the channel unnamed for an SMS publish, which reaches no topic", () => {
    // A PhoneNumber publish goes to a handset. Nothing subscribes to a
    // handset, so claiming a channel here would pair the send with
    // whatever else happened to be on that name.
    const publish =
      publishesIn(`
      import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
      const sns = new SNSClient({});
      async function text() {
        await sns.send(new PublishCommand({
          PhoneNumber: "+15555550100",
          Message: "your code is 1234",
        }));
      }
    `)[0] ?? raise("no publish");
    expect(channelOf(publish)).toBeNull();
  });

  it("takes a literal topic ARN as the channel the source wrote", () => {
    const publish =
      publishesIn(`
      import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
      const sns = new SNSClient({});
      async function announce() {
        await sns.send(new PublishCommand({
          TopicArn: "arn:aws:sns:us-east-1:123456789012:OrderEvents",
          Message: "{}",
        }));
      }
    `)[0] ?? raise("no publish");
    expect(channelOf(publish)).toBe(
      "arn:aws:sns:us-east-1:123456789012:OrderEvents",
    );
  });

  it("recognizes a namespace import", () => {
    const publishes = publishesIn(`
      import * as sns from "@aws-sdk/client-sns";
      const client = new sns.SNSClient({});
      async function announce() {
        await client.send(new sns.PublishCommand({
          TopicArn: process.env.ORDER_EVENTS_TOPIC_ARN,
          Message: "{}",
        }));
      }
    `);
    expect(publishes).toHaveLength(1);
  });

  it("leaves a PublishCommand from somewhere else alone", () => {
    const publishes = publishesIn(`
      import { SNSClient } from "@aws-sdk/client-sns";
      class PublishCommand {
        constructor(_input: unknown) {}
      }
      const sns = new SNSClient({});
      async function announce() {
        await sns.send(new PublishCommand({ TopicArn: "orders", Message: "{}" }));
      }
    `);
    expect(publishes).toHaveLength(0);
  });
});

describe("sns batch publish", () => {
  it("emits one message-send per entry, all on the topic the batch states once", () => {
    const publishes = publishesIn(`
      import { SNSClient, PublishBatchCommand } from "@aws-sdk/client-sns";
      const sns = new SNSClient({});
      async function announceAll() {
        await sns.send(new PublishBatchCommand({
          TopicArn: process.env.ORDER_EVENTS_TOPIC_ARN,
          PublishBatchRequestEntries: [
            { Id: "1", Message: "{}" },
            { Id: "2", Message: "{}" },
          ],
        }));
      }
    `);
    expect(publishes).toHaveLength(2);
    expect(publishes.map(channelOf)).toEqual([
      "{ORDER_EVENTS_TOPIC_ARN}",
      "{ORDER_EVENTS_TOPIC_ARN}",
    ]);
  });

  it("records the batch as one send when it cannot read the entries", () => {
    // A service that sends is not a service that sends nothing, so the
    // call is recorded with the topic and nothing claimed about the
    // messages.
    const publishes = publishesIn(`
      import { SNSClient, PublishBatchCommand } from "@aws-sdk/client-sns";
      const sns = new SNSClient({});
      async function announceAll(entries: unknown[]) {
        await sns.send(new PublishBatchCommand({
          TopicArn: process.env.ORDER_EVENTS_TOPIC_ARN,
          PublishBatchRequestEntries: entries,
        }));
      }
    `);
    expect(publishes).toHaveLength(1);
    expect(channelOf(publishes[0] ?? raise("no publish"))).toBe(
      "{ORDER_EVENTS_TOPIC_ARN}",
    );
  });
});
