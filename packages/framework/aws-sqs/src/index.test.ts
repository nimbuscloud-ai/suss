import { describe, expect, it } from "vitest";

import { boundaryKey } from "@suss/ir-core";
import { interactionsOf, packUnderTest } from "@suss/pack-harness";

import { sqsFramework } from "./index.js";

import type { Effect } from "@suss/behavioral-ir";

const raise = (msg: string): never => {
  throw new Error(msg);
};

// The recognizer walks an import back to the module that declared it,
// so every module a fixture imports has to be on disk.
const SQS_TYPES = `
export class SQSClient {
  constructor(config?: unknown);
  send(command: unknown): Promise<unknown>;
}
export class SendMessageCommand {
  constructor(input: { QueueUrl?: string; MessageBody?: string });
}
export class SendMessageBatchCommand {
  constructor(input: { QueueUrl?: string; Entries?: unknown[] });
}
`;

const LAMBDA_TYPES = `
export interface SQSRecord {
  messageId: string;
  body: string;
}
export interface SQSEvent {
  Records: SQSRecord[];
}
`;

/** A project's own dispatcher, for the configured-producer tests. */
const ASYNC_TYPES = `
export declare class CommandDispatcher {
  dispatch(subject: string, data: unknown, opts: unknown): Promise<void>;
  dispatchBatch(subject: string, entries: unknown[]): Promise<void>;
}
`;

/** A native package that exports its send as a plain function. */
const LEDGER_TYPES = `
export declare function publishEntry(queue: string, body: unknown): Promise<void>;
export declare function closeLedger(): Promise<void>;
export declare class Ledger {
  append(queue: string, body: unknown): Promise<void>;
  static append(queue: string, body: unknown): Promise<void>;
}
`;

const LIBRARY = {
  "@aws-sdk/client-sqs": SQS_TYPES,
  "aws-lambda": LAMBDA_TYPES,
  "@acme/async": ASYNC_TYPES,
  "@acme/ledger-native": LEDGER_TYPES,
};

/** The dispatcher config the configured-producer tests run with. */
const DISPATCHER_OPTIONS = {
  producers: [
    {
      module: "@acme/async",
      receiver: "CommandDispatcher",
      method: "dispatch",
      subjectArg: 0,
      bodyArg: 1,
    },
    {
      module: "@acme/async",
      receiver: "CommandDispatcher",
      method: "dispatchBatch",
      subjectArg: 0,
    },
  ],
};

const recognizeAll = (
  source: string,
  options?: Parameters<typeof sqsFramework>[0],
): Effect[] =>
  packUnderTest(sqsFramework(options), { library: LIBRARY }).effectsIn(source);

const messageSendEffectsOf = (effects: Effect[]) =>
  interactionsOf(effects, "message-send");

const messageReceiveEffectsOf = (effects: Effect[]) =>
  interactionsOf(effects, "message-receive");

function channelOf(
  effect: Extract<Effect, { type: "interaction" }>,
): string | null {
  const semantics = effect.binding.semantics;
  return semantics.name === "message-bus"
    ? semantics.channel
    : raise("not message-bus");
}

describe("sqs recognizer, through a project-local barrel", () => {
  it("recognizes a send whose import goes through a re-export barrel", () => {
    const sends = messageSendEffectsOf(
      packUnderTest(sqsFramework(), { library: LIBRARY }).effectsAcross(
        {
          // The barrel: an internal package re-exporting the SDK, which
          // is how shared aws helpers are packaged in production
          // monorepos.
          "/aws/sqs.ts": `export { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";`,
          "/producer.ts": `
      import { SQSClient, SendMessageCommand } from "./aws/sqs";
      const client = new SQSClient({});
      async function enqueue(order: { id: string }) {
        await client.send(new SendMessageCommand({
          QueueUrl: process.env.ORDERS_QUEUE_URL,
          MessageBody: JSON.stringify(order),
        }));
      }
    `,
        },
        "/producer.ts",
      ),
    );

    expect(sends).toHaveLength(1);
  });
});

describe("sqs recognizer: happy path", () => {
  it("emits one message-send interaction for client.send(new SendMessageCommand({...}))", () => {
    const source = `
      import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
      const client = new SQSClient({});
      async function enqueue(order: { id: string }) {
        await client.send(new SendMessageCommand({
          QueueUrl: process.env.ORDERS_QUEUE_URL,
          MessageBody: JSON.stringify(order),
        }));
      }
    `;
    const effects = recognizeAll(source);
    const sends = messageSendEffectsOf(effects);
    expect(sends).toHaveLength(1);
    const send = sends[0] ?? raise("no send effect");
    expect(send.binding.transport).toBe("aws_sqs");
    expect(send.binding.semantics.name).toBe("message-bus");
    if (send.binding.semantics.name === "message-bus") {
      expect(send.binding.semantics.messageBus).toBe("aws_sqs");
      expect(send.binding.semantics.channel).toBe("{ORDERS_QUEUE_URL}");
    }
  });

  it("captures MessageBody as the interaction body shape", () => {
    const source = `
      import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
      const client = new SQSClient({});
      async function enqueue(order: { id: string }) {
        await client.send(new SendMessageCommand({
          QueueUrl: process.env.ORDERS_QUEUE_URL,
          MessageBody: JSON.stringify(order),
        }));
      }
    `;
    const send =
      messageSendEffectsOf(recognizeAll(source))[0] ?? raise("no send");
    expect(send.interaction).toMatchObject({
      class: "message-send",
      body: expect.anything(),
    });
  });

  it("handles a literal QueueUrl (test/local dev pattern)", () => {
    const source = `
      import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
      const client = new SQSClient({});
      async function enqueue() {
        await client.send(new SendMessageCommand({
          QueueUrl: "https://sqs.us-east-1.amazonaws.com/123/orders",
          MessageBody: "hello",
        }));
      }
    `;
    const send =
      messageSendEffectsOf(recognizeAll(source))[0] ?? raise("no send");
    expect(send.binding.semantics).toMatchObject({
      name: "message-bus",
      messageBus: "aws_sqs",
      channel: "https://sqs.us-east-1.amazonaws.com/123/orders",
    });
  });

  it("recognizes namespace import (`import * as sqs from ...`)", () => {
    const source = `
      import * as sqs from "@aws-sdk/client-sqs";
      const client = new sqs.SQSClient({});
      async function enqueue() {
        await client.send(new sqs.SendMessageCommand({
          QueueUrl: process.env.ORDERS_QUEUE_URL,
          MessageBody: "hello",
        }));
      }
    `;
    const sends = messageSendEffectsOf(recognizeAll(source));
    expect(sends).toHaveLength(1);
    expect(sends[0]?.binding.semantics).toMatchObject({
      name: "message-bus",
      messageBus: "aws_sqs",
      channel: "{ORDERS_QUEUE_URL}",
    });
  });

  it("recognizes SendMessageBatchCommand", () => {
    const source = `
      import { SQSClient, SendMessageBatchCommand } from "@aws-sdk/client-sqs";
      const client = new SQSClient({});
      async function enqueueBatch() {
        await client.send(new SendMessageBatchCommand({
          QueueUrl: process.env.ORDERS_QUEUE_URL,
          Entries: [],
        }));
      }
    `;
    const sends = messageSendEffectsOf(recognizeAll(source));
    expect(sends).toHaveLength(1);
  });
});

describe("a send whose queue the code does not name", () => {
  it("is still a send", () => {
    // The queue arrives as a parameter, which is what a wrapper around
    // the SDK looks like. Dropping the whole effect made a service that
    // sends to a queue read as a service that sends nothing.
    const source = `
      import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
      const client = new SQSClient();
      export async function publish(queue: string, body: string) {
        await client.send(new SendMessageCommand({
          QueueUrl: queue,
          MessageBody: body,
        }));
      }
    `;

    expect(messageSendEffectsOf(recognizeAll(source))).toHaveLength(1);
  });

  it("keeps the reference, so a caller can ground which queue", () => {
    // A caller passes the queue, so a caller can ground it. The
    // channel keeps the reference for whoever knows, the same as an
    // env var kept its name.
    const source = `
      import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
      const client = new SQSClient();
      export async function publish(queue: string) {
        await client.send(new SendMessageCommand({ QueueUrl: queue }));
      }
    `;

    const [effect] = messageSendEffectsOf(recognizeAll(source));
    const binding = effect?.binding ?? raise("no binding");
    const semantics = binding.semantics;
    expect(semantics.name === "message-bus" && semantics.channel).toBe(
      "{queue}",
    );
  });
});

describe("sqs recognizer: rejection cases", () => {
  it("ignores .send() with a non-SQS command class", () => {
    const source = `
      class FakeCommand {
        constructor(public input: unknown) {}
      }
      const client = { send: async (c: unknown) => c };
      async function noop() {
        await client.send(new FakeCommand({
          QueueUrl: "x",
          MessageBody: "y",
        }));
      }
    `;
    expect(messageSendEffectsOf(recognizeAll(source))).toEqual([]);
  });

  it("ignores SendMessageCommand from the wrong module", () => {
    const source = `
      // SendMessageCommand exists locally but is NOT from @aws-sdk/client-sqs.
      class SendMessageCommand {
        constructor(public input: unknown) {}
      }
      const client = { send: async (c: unknown) => c };
      async function noop() {
        await client.send(new SendMessageCommand({
          QueueUrl: process.env.X,
          MessageBody: "y",
        }));
      }
    `;
    expect(messageSendEffectsOf(recognizeAll(source))).toEqual([]);
  });

  it("ignores .send() called on something other than a New expression", () => {
    const source = `
      import { SQSClient } from "@aws-sdk/client-sqs";
      const client = new SQSClient({});
      async function noop() {
        await client.send("a string, not a command");
      }
    `;
    expect(messageSendEffectsOf(recognizeAll(source))).toEqual([]);
  });

  it("ignores method calls that aren't .send", () => {
    const source = `
      import { SendMessageCommand } from "@aws-sdk/client-sqs";
      const command = new SendMessageCommand({
        QueueUrl: process.env.X,
        MessageBody: "y",
      });
      async function noop() {
        // Constructed but not sent: no .send call.
        return command;
      }
    `;
    expect(messageSendEffectsOf(recognizeAll(source))).toEqual([]);
  });

  it("reads a queue through a call with one literal return", () => {
    // The hand-rolled reader stopped at the call. The ops follow it to
    // its single return, so a project that centralises its URL in a
    // helper reads the same as one that writes the literal in place.
    const source = `
      import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
      const client = new SQSClient({});
      function buildUrl(): string { return "x"; }
      async function noop() {
        await client.send(new SendMessageCommand({
          QueueUrl: buildUrl(),
          MessageBody: "y",
        }));
      }
    `;

    const [effect] = messageSendEffectsOf(recognizeAll(source));
    const binding = effect?.binding ?? raise("no binding");
    expect(
      binding.semantics.name === "message-bus" && binding.semantics.channel,
    ).toBe("x");
  });

  it("records a send whose queue is decided at run time", () => {
    const source = `
      import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
      const client = new SQSClient({});
      function buildUrl(): string { return ["a", "b"][Date.now() % 2]!; }
      async function noop() {
        await client.send(new SendMessageCommand({
          QueueUrl: buildUrl(),
          MessageBody: "y",
        }));
      }
    `;

    // The queue cannot be read, so nothing is claimed about which one it
    // is, and the boundary pairs with nothing. The send still happened.
    const [effect] = messageSendEffectsOf(recognizeAll(source));
    const binding = effect?.binding ?? raise("no binding");
    expect(
      binding.semantics.name === "message-bus" && binding.semantics.channel,
    ).toBeNull();
    expect(boundaryKey(binding)).toBeNull();
  });

  it("reads an input a const states, since the ops follow it", () => {
    // The hand-rolled reader gave up when the command's input was not
    // written inline. The ops resolve the const, so a project that
    // builds its input above the call reads the same as one that
    // writes it in place.
    const source = `
      import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
      const client = new SQSClient({});
      const input = { QueueUrl: process.env.X, MessageBody: "y" };
      async function noop() {
        await client.send(new SendMessageCommand(input));
      }
    `;
    const [effect] = messageSendEffectsOf(recognizeAll(source));
    const binding = effect?.binding ?? raise("no binding");
    expect(
      binding.semantics.name === "message-bus" && binding.semantics.channel,
    ).toBe("{X}");
  });
});

describe("sqs message-receive recognizer", () => {
  it("emits a message-receive interaction for JSON.parse(record.body) inside for-of(event.Records)", () => {
    const source = `
      import type { SQSEvent } from "aws-lambda";
      export async function handler(event: SQSEvent): Promise<void> {
        for (const record of event.Records) {
          const { id, totalAmount } = JSON.parse(record.body);
          void id; void totalAmount;
        }
      }
    `;
    const receives = messageReceiveEffectsOf(recognizeAll(source));
    expect(receives).toHaveLength(1);
    const receive = receives[0] ?? raise("no receive effect");
    expect(receive.binding.semantics).toMatchObject({
      name: "message-bus",
      messageBus: "aws_sqs",
      // Channel intentionally empty: pairing layer fills from CFN
      // consumer summary's binding via codeScope.
      channel: null,
    });
  });

  it("captures destructured field names as the interaction body shape", () => {
    const source = `
      import type { SQSEvent } from "aws-lambda";
      export async function handler(event: SQSEvent): Promise<void> {
        for (const record of event.Records) {
          const { id, totalAmount } = JSON.parse(record.body);
          void id; void totalAmount;
        }
      }
    `;
    const receive =
      messageReceiveEffectsOf(recognizeAll(source))[0] ?? raise("no receive");
    if (receive.interaction.class !== "message-receive") {
      throw new Error("wrong interaction class");
    }
    const body = receive.interaction.body as
      | { kind?: string; fields?: Record<string, unknown> }
      | undefined;
    expect(body?.kind).toBe("object");
    expect(Object.keys(body?.fields ?? {}).sort()).toEqual([
      "id",
      "totalAmount",
    ]);
  });

  it("emits no body when the parse result isn't destructured", () => {
    const source = `
      import type { SQSEvent } from "aws-lambda";
      export async function handler(event: SQSEvent): Promise<void> {
        for (const record of event.Records) {
          const order = JSON.parse(record.body);
          void order;
        }
      }
    `;
    const receives = messageReceiveEffectsOf(recognizeAll(source));
    expect(receives).toHaveLength(1);
    const receive = receives[0] ?? raise("no receive");
    if (receive.interaction.class !== "message-receive") {
      throw new Error("wrong interaction class");
    }
    expect(receive.interaction.body).toBeUndefined();
  });

  it("uses the destructured PROPERTY name not the local alias", () => {
    // const { total: localAlias }: `total` is the property the
    // recognizer should record (matching what producers write), not
    // `localAlias`.
    const source = `
      import type { SQSEvent } from "aws-lambda";
      export async function handler(event: SQSEvent): Promise<void> {
        for (const record of event.Records) {
          const { total: localAlias } = JSON.parse(record.body);
          void localAlias;
        }
      }
    `;
    const receive =
      messageReceiveEffectsOf(recognizeAll(source))[0] ?? raise("no receive");
    if (receive.interaction.class !== "message-receive") {
      throw new Error("wrong interaction class");
    }
    const body = receive.interaction.body as {
      fields: Record<string, unknown>;
    };
    expect(Object.keys(body.fields)).toEqual(["total"]);
  });

  it("reads a record handed to a callback over event.Records", () => {
    const source = `
      import type { SQSEvent } from "aws-lambda";
      export async function handler(event: SQSEvent): Promise<void> {
        event.Records.map((record) => {
          const { id } = JSON.parse(record.body);
          return id;
        });
      }
    `;
    expect(messageReceiveEffectsOf(recognizeAll(source))).toHaveLength(1);
  });

  it.each([
    ["the Lambda record type", "SQSRecord"],
    ["an intersection", "SQSRecord & { attempt: number }"],
    ["an optional", "SQSRecord | undefined"],
    ["an alias of an intersection", "QueuedOrder"],
    ["an alias of an optional", "MaybeQueuedOrder"],
  ])("reads a record typed as %s in a helper", (_, typed) => {
    const source = `
      import type { SQSRecord } from "aws-lambda";
      type QueuedOrder = SQSRecord & { attempt: number };
      type MaybeQueuedOrder = QueuedOrder | undefined;
      export function readOrder(record: ${typed}): string {
        const { id } = JSON.parse(record.body);
        return id;
      }
    `;
    expect(messageReceiveEffectsOf(recognizeAll(source))).toHaveLength(1);
  });

  it("ignores a record type the project declares itself", () => {
    const source = `
      interface SQSRecord { body: string }
      export function readOrder(record: SQSRecord): string {
        const { id } = JSON.parse(record.body);
        return id;
      }
    `;
    expect(messageReceiveEffectsOf(recognizeAll(source))).toEqual([]);
  });

  it("ignores JSON.parse calls outside event.Records loops", () => {
    const source = `
      export async function handler(input: string): Promise<unknown> {
        return JSON.parse(input);
      }
    `;
    expect(messageReceiveEffectsOf(recognizeAll(source))).toEqual([]);
  });

  it("ignores JSON.parse on non-.body access", () => {
    const source = `
      import type { SQSEvent } from "aws-lambda";
      export async function handler(event: SQSEvent): Promise<void> {
        for (const record of event.Records) {
          const x = JSON.parse(record.messageId);
          void x;
        }
      }
    `;
    expect(messageReceiveEffectsOf(recognizeAll(source))).toEqual([]);
  });

  it("ignores parse calls that aren't JSON.parse", () => {
    const source = `
      import type { SQSEvent } from "aws-lambda";
      const myParser = { parse: (_: string): unknown => null };
      export async function handler(event: SQSEvent): Promise<void> {
        for (const record of event.Records) {
          const x = myParser.parse(record.body);
          void x;
        }
      }
    `;
    expect(messageReceiveEffectsOf(recognizeAll(source))).toEqual([]);
  });

  it("handles `as` cast on the parse result without breaking destructuring extraction", () => {
    const source = `
      import type { SQSEvent } from "aws-lambda";
      interface Order { id: string; total: number }
      export async function handler(event: SQSEvent): Promise<void> {
        for (const record of event.Records) {
          const { id, total } = JSON.parse(record.body) as Order;
          void id; void total;
        }
      }
    `;
    const receive =
      messageReceiveEffectsOf(recognizeAll(source))[0] ?? raise("no receive");
    if (receive.interaction.class !== "message-receive") {
      throw new Error("wrong interaction class");
    }
    const body = receive.interaction.body as {
      fields: Record<string, unknown>;
    };
    expect(Object.keys(body.fields).sort()).toEqual(["id", "total"]);
  });
});

describe("sqs pack metadata", () => {
  it("declares correct pack identity (no discovery, no terminals, recognizer present)", () => {
    const pack = sqsFramework();
    expect(pack.name).toBe("sqs");
    expect(pack.protocol).toBe("sqs");
    expect(pack.discovery).toEqual([]);
    expect(pack.terminals).toEqual([]);
    // Two recognizers: producer-side (sqsRecognizer) and consumer-side
    // (messageReceiveRecognizer).
    // The two send declarations compile to one recognizer each, plus
    // the consumer-side receive recognizer.
    expect(pack.invocationRecognizers).toHaveLength(3);
  });

  it("adds a recognizer and an import gate per configured producer", () => {
    const pack = sqsFramework(DISPATCHER_OPTIONS);
    expect(pack.invocationRecognizers).toHaveLength(5);
    expect(pack.requiresImport).toEqual([
      "@aws-sdk/client-sqs",
      "aws-lambda",
      "@acme/async",
    ]);
  });
});

describe("sqs configured producer", () => {
  it("reads a send on the project's own dispatcher", () => {
    const source = `
      import { CommandDispatcher } from "@acme/async";
      export async function place(dispatcher: CommandDispatcher) {
        await dispatcher.dispatch(
          "order.placed",
          { orderId: "o-1", total: "9" },
          { queueUrl: process.env.ORDERS_QUEUE_URL }
        );
      }
    `;

    const sends = messageSendEffectsOf(
      recognizeAll(source, DISPATCHER_OPTIONS),
    );
    expect(sends).toHaveLength(1);
    const send = sends[0];
    expect(send.binding.semantics).toEqual({
      name: "message-bus",
      messageBus: "aws_sqs",
      channel: "order.placed",
    });
    expect(send.binding.recognition).toBe("@suss/framework-aws-sqs");
    expect(send.callee).toBe("dispatcher.dispatch");
    if (send.interaction.class !== "message-send") {
      throw new Error("wrong interaction class");
    }
    expect(send.interaction.body).toEqual({
      kind: "object",
      fields: {
        orderId: { kind: "string", value: "o-1" },
        total: { kind: "string", value: "9" },
      },
    });
  });

  it("records the send with no channel when the subject is a parameter", () => {
    const source = `
      import { CommandDispatcher } from "@acme/async";
      export async function place(dispatcher: CommandDispatcher, kind: string) {
        await dispatcher.dispatch(kind, { orderId: "o-1" }, { queueUrl: "u" });
      }
    `;

    const sends = messageSendEffectsOf(
      recognizeAll(source, DISPATCHER_OPTIONS),
    );
    expect(sends.map((send) => send.binding.semantics)).toEqual([
      { name: "message-bus", messageBus: "aws_sqs", channel: null },
    ]);
  });

  it("records one send per member of a union-typed subject", () => {
    const source = `
      import { CommandDispatcher } from "@acme/async";
      type Topic = "order.shipped" | "order.cancelled";
      export async function move(dispatcher: CommandDispatcher, topic: Topic) {
        await dispatcher.dispatch(topic, { at: 1 }, {});
      }
    `;

    const sends = messageSendEffectsOf(
      recognizeAll(source, DISPATCHER_OPTIONS),
    );
    expect(sends.map((send) => send.binding.semantics)).toEqual([
      {
        name: "message-bus",
        messageBus: "aws_sqs",
        channel: "order.cancelled",
      },
      { name: "message-bus", messageBus: "aws_sqs", channel: "order.shipped" },
    ]);
  });

  it("reads a subject a constant settles, and a body a local holds", () => {
    const source = `
      import { CommandDispatcher } from "@acme/async";
      const config = { queue: process.env.ORDERS_QUEUE ?? "orders" };
      export async function place(dispatcher: CommandDispatcher) {
        const body = { orderId: "o-1" };
        await dispatcher.dispatch(config.queue, body, {});
      }
    `;

    const sends = messageSendEffectsOf(
      recognizeAll(source, DISPATCHER_OPTIONS),
    );
    expect(sends.map((send) => send.binding.semantics)).toEqual([
      { name: "message-bus", messageBus: "aws_sqs", channel: "orders" },
    ]);
    if (sends[0].interaction.class !== "message-send") {
      throw new Error("wrong interaction class");
    }
    expect(sends[0].interaction.body).toEqual({
      kind: "object",
      fields: { orderId: { kind: "string", value: "o-1" } },
    });
  });

  it("carries no body for a batch method the config gives no body argument", () => {
    const source = `
      import { CommandDispatcher } from "@acme/async";
      export async function placeMany(dispatcher: CommandDispatcher) {
        await dispatcher.dispatchBatch("order.placed", []);
      }
    `;

    const sends = messageSendEffectsOf(
      recognizeAll(source, DISPATCHER_OPTIONS),
    );
    expect(sends).toHaveLength(1);
    if (sends[0].interaction.class !== "message-send") {
      throw new Error("wrong interaction class");
    }
    expect(sends[0].interaction.body).toBeUndefined();
    expect(sends[0].binding.semantics).toEqual({
      name: "message-bus",
      messageBus: "aws_sqs",
      channel: "order.placed",
    });
  });

  it("reads nothing without the config, on the same source", () => {
    const source = `
      import { CommandDispatcher } from "@acme/async";
      export async function place(dispatcher: CommandDispatcher) {
        await dispatcher.dispatch("order.placed", { orderId: "o-1" }, {});
      }
    `;

    expect(messageSendEffectsOf(recognizeAll(source))).toEqual([]);
  });

  it.each([
    ["an intersection", "CommandDispatcher & { region: string }"],
    ["an optional", "CommandDispatcher | undefined"],
    ["an alias of an intersection", "Dispatcher"],
    ["an alias of an optional", "MaybeDispatcher"],
  ])("reads a send on a dispatcher typed as %s", (_, typed) => {
    const source = `
      import { CommandDispatcher } from "@acme/async";
      type Dispatcher = CommandDispatcher & { region: string };
      type MaybeDispatcher = Dispatcher | undefined;
      export async function place(dispatcher: ${typed}) {
        await dispatcher.dispatchBatch("order.placed", []);
      }
    `;

    const sends = messageSendEffectsOf(
      recognizeAll(source, DISPATCHER_OPTIONS),
    );
    expect(sends.map((send) => send.binding.semantics)).toEqual([
      { name: "message-bus", messageBus: "aws_sqs", channel: "order.placed" },
    ]);
  });

  it("reads a send on a dispatcher held in a field", () => {
    const source = `
      import type { CommandDispatcher } from "@acme/async";
      export class Sender {
        constructor(private readonly dispatcher: CommandDispatcher) {}
        async send() {
          await this.dispatcher.dispatch("push.send", { userId: "u" }, {});
        }
      }
    `;

    const sends = messageSendEffectsOf(
      recognizeAll(source, DISPATCHER_OPTIONS),
    );
    expect(sends.map((send) => [channelOf(send), send.callee])).toEqual([
      ["push.send", "this.dispatcher.dispatch"],
    ]);
  });

  it("reads a dispatcher imported through a sub-path of its module", () => {
    const sends = messageSendEffectsOf(
      packUnderTest(sqsFramework(DISPATCHER_OPTIONS), {
        library: LIBRARY,
      }).effectsAcross(
        {
          "/node_modules/@acme/async/commands.d.ts": `export { CommandDispatcher } from "./index.js";`,
          "/repo.ts": `
            import { CommandDispatcher } from "@acme/async/commands";
            export async function place(dispatcher: CommandDispatcher) {
              await dispatcher.dispatch("order.placed", {}, {});
            }
          `,
        },
        "/repo.ts",
      ),
    );

    expect(sends.map(channelOf)).toEqual(["order.placed"]);
  });

  it("reads a dispatcher the project declares, by the path the stub gives from the project root", () => {
    const sends = messageSendEffectsOf(
      packUnderTest(
        sqsFramework({
          producers: [
            {
              module: "./messaging/dispatcher",
              receiver: "CommandDispatcher",
              method: "dispatch",
              subjectArg: 0,
            },
          ],
        }),
        { library: LIBRARY },
      ).effectsAcross(
        {
          "/messaging/dispatcher.ts": `
            export class CommandDispatcher {
              async dispatch(subject: string, data: unknown) {}
            }
          `,
          "/orders/send.ts": `
            import { CommandDispatcher } from "../messaging/dispatcher";
            export async function send(dispatcher: CommandDispatcher) {
              await dispatcher.dispatch("order.placed", {});
            }
          `,
        },
        "/orders/send.ts",
      ),
    );

    expect(sends.map(channelOf)).toEqual(["order.placed"]);
  });
});

describe("sqs producer stated as an export", () => {
  const LEDGER_OPTIONS = {
    producers: [
      {
        module: "@acme/ledger-native",
        export: "publishEntry",
        subject: { at: 0 },
        payload: { at: 1 },
      },
    ],
  };

  it("reads each call of the export, bare or through a namespace import", () => {
    const source = `
      import { publishEntry } from "@acme/ledger-native";
      import * as ledger from "@acme/ledger-native";
      export async function record() {
        await publishEntry("ledger-queue", { amount: "9" });
        await ledger.publishEntry("ledger-audit", { amount: "9" });
      }
    `;

    const sends = messageSendEffectsOf(recognizeAll(source, LEDGER_OPTIONS));
    expect(sends.map((send) => [send.binding.semantics, send.callee])).toEqual([
      [
        { name: "message-bus", messageBus: "aws_sqs", channel: "ledger-queue" },
        "publishEntry",
      ],
      [
        { name: "message-bus", messageBus: "aws_sqs", channel: "ledger-audit" },
        "ledger.publishEntry",
      ],
    ]);
    if (sends[0].interaction.class !== "message-send") {
      throw new Error("wrong interaction class");
    }
    expect(sends[0].interaction.body).toEqual({
      kind: "object",
      fields: { amount: { kind: "string", value: "9" } },
    });
  });

  it("reads a call through an alias of the export", () => {
    const source = `
      import { publishEntry as publish } from "@acme/ledger-native";
      export async function record() {
        await publish("ledger-queue", {});
      }
    `;

    const sends = messageSendEffectsOf(recognizeAll(source, LEDGER_OPTIONS));
    expect(sends.map((send) => [channelOf(send), send.callee])).toEqual([
      ["ledger-queue", "publish"],
    ]);
  });

  it("reads nothing for another export of the package, or a local function of the same name", () => {
    const source = `
      import { closeLedger } from "@acme/ledger-native";
      function publishEntry(queue: string, body: unknown) {}
      export async function record() {
        await closeLedger();
        publishEntry("ledger-queue", {});
      }
    `;

    expect(messageSendEffectsOf(recognizeAll(source, LEDGER_OPTIONS))).toEqual(
      [],
    );
  });

  it("reads the call when the package is not installed", () => {
    const source = `
      import { publishEntry } from "@acme/unpublished";
      export async function record() {
        await publishEntry("ledger-queue", {});
      }
    `;

    const sends = messageSendEffectsOf(
      recognizeAll(source, {
        producers: [
          {
            module: "@acme/unpublished",
            export: "publishEntry",
            subject: { at: 0 },
          },
        ],
      }),
    );
    expect(sends.map(channelOf)).toEqual(["ledger-queue"]);
  });

  it("reads a method on an instance the class made, or on the class, for an export written Class.method", () => {
    const source = `
      import { Ledger } from "@acme/ledger-native";
      const ledger = new Ledger();
      export async function record(given: Ledger) {
        await ledger.append("ledger-queue", {});
        await Ledger.append("ledger-static", {});
        await given.append("ledger-given", {});
      }
    `;

    const sends = messageSendEffectsOf(
      recognizeAll(source, {
        producers: [
          {
            module: "@acme/ledger-native",
            export: "Ledger.append",
            subject: { at: 0 },
          },
        ],
      }),
    );
    // Nothing ties a parameter to the class's constructor, so the call
    // on it is not attributed to the export.
    expect(sends.map((send) => [channelOf(send), send.callee])).toEqual([
      ["ledger-queue", "ledger.append"],
      ["ledger-static", "Ledger.append"],
    ]);
  });

  it("reads the files that import the export's module", () => {
    expect(sqsFramework(LEDGER_OPTIONS).requiresImport).toContain(
      "@acme/ledger-native",
    );
  });
});
