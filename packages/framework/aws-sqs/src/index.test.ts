import { type CallExpression, Node, type SourceFile } from "ts-morph";
import { describe, expect, it } from "vitest";

import { isImportedFrom } from "@suss/adapter-typescript";
import { boundaryKey } from "@suss/ir-core";
import { createTestProject } from "@suss/test-project";

import { sqsFramework } from "./index.js";

import type { Effect } from "@suss/behavioral-ir";
import type { EffectArg } from "@suss/extractor";

const raise = (msg: string): never => {
  throw new Error(msg);
};

/**
 * Build an in-memory ts-morph Project with a fake `@aws-sdk/client-sqs`
 * .d.ts so the recognizer's import-source check (`isImportedFrom`) has
 * symbols to resolve against. Returns a ready-to-use SourceFile.
 */
function makeProject(userSource: string): SourceFile {
  const project = createTestProject();

  // Minimal fake @aws-sdk/client-sqs surface: enough for the
  // recognizer to walk the import to its source.
  project.createSourceFile(
    "node_modules/@aws-sdk/client-sqs/index.d.ts",
    `
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
`,
  );

  // Minimal fake aws-lambda types: for the consumer-side
  // messageReceiveRecognizer's import gate.
  project.createSourceFile(
    "node_modules/aws-lambda/index.d.ts",
    `
export interface SQSRecord {
  messageId: string;
  body: string;
}
export interface SQSEvent {
  Records: SQSRecord[];
}
`,
  );

  // A project's own dispatcher, for the configured-producer tests.
  project.createSourceFile(
    "node_modules/@acme/async/package.json",
    JSON.stringify({ name: "@acme/async", types: "index.d.ts" }),
  );
  project.createSourceFile(
    "node_modules/@acme/async/index.d.ts",
    `
export declare class CommandDispatcher {
  dispatch(subject: string, data: unknown, opts: unknown): Promise<void>;
  dispatchBatch(subject: string, entries: unknown[]): Promise<void>;
}
`,
  );

  return project.createSourceFile("user.ts", userSource);
}

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

/**
 * Walk the source file and run the SQS recognizer on every CallExpression.
 * Returns the flat list of emitted effects.
 *
 * Not using the adapter's runInvocationRecognizers here because that
 * would pull the adapter as a dependency for unit tests: these tests
 * exercise the recognizer in isolation.
 */
function recognizeAll(
  sourceFile: SourceFile,
  options?: Parameters<typeof sqsFramework>[0],
): Effect[] {
  const pack = sqsFramework(options);
  const recognizers = pack.invocationRecognizers ?? [];
  if (recognizers.length === 0) {
    return raise("expected pack to declare invocationRecognizers");
  }
  const effects: Effect[] = [];
  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) {
      return;
    }
    const ctx = {
      call: node as CallExpression,
      sourceFile,
      extractArgs: (): EffectArg[] => extractArgsForTest(node),
      isImportedFrom,
    };
    for (const recognizer of recognizers) {
      const emitted = recognizer(node, ctx);
      if (emitted !== null) {
        effects.push(...emitted);
      }
    }
  });
  return effects;
}

/**
 * A small EffectArg builder for tests. It handles the object, string,
 * identifier, and `new (...)` forms the recognizer reads, mirroring the
 * adapter's extractArgs closely enough for the SQS recognizer.
 */
function extractArgsForTest(call: CallExpression): EffectArg[] {
  return call.getArguments().map((arg) => extractArgForTest(arg));
}

function extractArgForTest(node: Node): EffectArg {
  if (Node.isStringLiteral(node)) {
    return { kind: "string", value: node.getLiteralValue() };
  }
  if (Node.isObjectLiteralExpression(node)) {
    const fields: Record<string, EffectArg> = {};
    for (const prop of node.getProperties()) {
      if (!Node.isPropertyAssignment(prop)) {
        continue;
      }
      const initializer = prop.getInitializer();
      if (initializer === undefined) {
        continue;
      }
      fields[prop.getName()] = extractArgForTest(initializer);
    }
    return { kind: "object", fields };
  }
  if (Node.isNewExpression(node)) {
    return {
      kind: "call",
      callee: node.getExpression().getText(),
      args: node.getArguments().map((a) => extractArgForTest(a)),
    };
  }
  if (Node.isIdentifier(node) || Node.isPropertyAccessExpression(node)) {
    return { kind: "identifier", name: node.getText() };
  }
  if (Node.isCallExpression(node)) {
    return {
      kind: "call",
      callee: node.getExpression().getText(),
      args: node.getArguments().map((a) => extractArgForTest(a)),
    };
  }
  return null;
}

function messageSendEffectsOf(
  effects: Effect[],
): Array<Extract<Effect, { type: "interaction" }>> {
  return effects.filter(
    (e): e is Extract<Effect, { type: "interaction" }> =>
      e.type === "interaction" && e.interaction.class === "message-send",
  );
}

describe("sqs recognizer, through a project-local barrel", () => {
  it("recognizes a send whose import goes through a re-export barrel", () => {
    const project = createTestProject();
    project.createSourceFile(
      "node_modules/@aws-sdk/client-sqs/index.d.ts",
      `
export class SQSClient {
  constructor(config?: unknown);
  send(command: unknown): Promise<unknown>;
}
export class SendMessageCommand {
  constructor(input: { QueueUrl?: string; MessageBody?: string });
}
`,
    );
    // The barrel: an internal package re-exporting the SDK, which is
    // how shared aws helpers are packaged in production monorepos.
    project.createSourceFile(
      "aws/sqs.ts",
      `export { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";`,
    );
    const file = project.createSourceFile(
      "producer.ts",
      `
      import { SQSClient, SendMessageCommand } from "./aws/sqs";
      const client = new SQSClient({});
      async function enqueue(order: { id: string }) {
        await client.send(new SendMessageCommand({
          QueueUrl: process.env.ORDERS_QUEUE_URL,
          MessageBody: JSON.stringify(order),
        }));
      }
    `,
    );

    const sends = messageSendEffectsOf(recognizeAll(file));
    expect(sends).toHaveLength(1);
  });
});

describe("sqs recognizer: happy path", () => {
  it("emits one message-send interaction for client.send(new SendMessageCommand({...}))", () => {
    const file = makeProject(`
      import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
      const client = new SQSClient({});
      async function enqueue(order: { id: string }) {
        await client.send(new SendMessageCommand({
          QueueUrl: process.env.ORDERS_QUEUE_URL,
          MessageBody: JSON.stringify(order),
        }));
      }
    `);
    const effects = recognizeAll(file);
    const sends = messageSendEffectsOf(effects);
    expect(sends).toHaveLength(1);
    const send = sends[0] ?? raise("no send effect");
    expect(send.binding.transport).toBe("sqs");
    expect(send.binding.semantics.name).toBe("message-bus");
    if (send.binding.semantics.name === "message-bus") {
      expect(send.binding.semantics.messageBus).toBe("sqs");
      expect(send.binding.semantics.channel).toBe("ORDERS_QUEUE_URL");
    }
  });

  it("captures MessageBody as the interaction body shape", () => {
    const file = makeProject(`
      import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
      const client = new SQSClient({});
      async function enqueue(order: { id: string }) {
        await client.send(new SendMessageCommand({
          QueueUrl: process.env.ORDERS_QUEUE_URL,
          MessageBody: JSON.stringify(order),
        }));
      }
    `);
    const send =
      messageSendEffectsOf(recognizeAll(file))[0] ?? raise("no send");
    expect(send.interaction).toMatchObject({
      class: "message-send",
      body: expect.anything(),
    });
  });

  it("handles a literal QueueUrl (test/local dev pattern)", () => {
    const file = makeProject(`
      import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
      const client = new SQSClient({});
      async function enqueue() {
        await client.send(new SendMessageCommand({
          QueueUrl: "https://sqs.us-east-1.amazonaws.com/123/orders",
          MessageBody: "hello",
        }));
      }
    `);
    const send =
      messageSendEffectsOf(recognizeAll(file))[0] ?? raise("no send");
    expect(send.binding.semantics).toMatchObject({
      name: "message-bus",
      messageBus: "sqs",
      channel: "https://sqs.us-east-1.amazonaws.com/123/orders",
    });
  });

  it("recognizes namespace import (`import * as sqs from ...`)", () => {
    const file = makeProject(`
      import * as sqs from "@aws-sdk/client-sqs";
      const client = new sqs.SQSClient({});
      async function enqueue() {
        await client.send(new sqs.SendMessageCommand({
          QueueUrl: process.env.ORDERS_QUEUE_URL,
          MessageBody: "hello",
        }));
      }
    `);
    const sends = messageSendEffectsOf(recognizeAll(file));
    expect(sends).toHaveLength(1);
    expect(sends[0]?.binding.semantics).toMatchObject({
      name: "message-bus",
      messageBus: "sqs",
      channel: "ORDERS_QUEUE_URL",
    });
  });

  it("recognizes SendMessageBatchCommand", () => {
    const file = makeProject(`
      import { SQSClient, SendMessageBatchCommand } from "@aws-sdk/client-sqs";
      const client = new SQSClient({});
      async function enqueueBatch() {
        await client.send(new SendMessageBatchCommand({
          QueueUrl: process.env.ORDERS_QUEUE_URL,
          Entries: [],
        }));
      }
    `);
    const sends = messageSendEffectsOf(recognizeAll(file));
    expect(sends).toHaveLength(1);
  });
});

describe("a send whose queue the code does not name", () => {
  it("is still a send", () => {
    // The queue arrives as a parameter, which is what a wrapper around
    // the SDK looks like. Dropping the whole effect made a service that
    // sends to a queue read as a service that sends nothing.
    const file = makeProject(`
      import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
      const client = new SQSClient();
      export async function publish(queue: string, body: string) {
        await client.send(new SendMessageCommand({
          QueueUrl: queue,
          MessageBody: body,
        }));
      }
    `);

    expect(messageSendEffectsOf(recognizeAll(file))).toHaveLength(1);
  });

  it("names no queue, so it pairs with nothing", () => {
    const file = makeProject(`
      import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
      const client = new SQSClient();
      export async function publish(queue: string) {
        await client.send(new SendMessageCommand({ QueueUrl: queue }));
      }
    `);

    const [effect] = messageSendEffectsOf(recognizeAll(file));
    const binding = effect?.binding ?? raise("no binding");
    const semantics = binding.semantics;
    expect(semantics.name === "message-bus" && semantics.channel).toBeNull();
    expect(boundaryKey(binding)).toBeNull();
  });
});

describe("sqs recognizer: rejection cases", () => {
  it("ignores .send() with a non-SQS command class", () => {
    const file = makeProject(`
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
    `);
    expect(messageSendEffectsOf(recognizeAll(file))).toEqual([]);
  });

  it("ignores SendMessageCommand from the wrong module", () => {
    const file = makeProject(`
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
    `);
    expect(messageSendEffectsOf(recognizeAll(file))).toEqual([]);
  });

  it("ignores .send() called on something other than a New expression", () => {
    const file = makeProject(`
      import { SQSClient } from "@aws-sdk/client-sqs";
      const client = new SQSClient({});
      async function noop() {
        await client.send("a string, not a command");
      }
    `);
    expect(messageSendEffectsOf(recognizeAll(file))).toEqual([]);
  });

  it("ignores method calls that aren't .send", () => {
    const file = makeProject(`
      import { SendMessageCommand } from "@aws-sdk/client-sqs";
      const command = new SendMessageCommand({
        QueueUrl: process.env.X,
        MessageBody: "y",
      });
      async function noop() {
        // Constructed but not sent: no .send call.
        return command;
      }
    `);
    expect(messageSendEffectsOf(recognizeAll(file))).toEqual([]);
  });

  it("records a send whose queue comes back from a call", () => {
    const file = makeProject(`
      import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
      const client = new SQSClient({});
      function buildUrl(): string { return "x"; }
      async function noop() {
        await client.send(new SendMessageCommand({
          QueueUrl: buildUrl(),
          MessageBody: "y",
        }));
      }
    `);

    // The queue cannot be read, so nothing is claimed about which one it
    // is, and the boundary pairs with nothing. The send still happened.
    const [effect] = messageSendEffectsOf(recognizeAll(file));
    const binding = effect?.binding ?? raise("no binding");
    expect(
      binding.semantics.name === "message-bus" && binding.semantics.channel,
    ).toBeNull();
    expect(boundaryKey(binding)).toBeNull();
  });

  it("returns null when SendMessageCommand input isn't an object literal", () => {
    const file = makeProject(`
      import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
      const client = new SQSClient({});
      const input = { QueueUrl: process.env.X, MessageBody: "y" };
      async function noop() {
        await client.send(new SendMessageCommand(input));
      }
    `);
    expect(messageSendEffectsOf(recognizeAll(file))).toEqual([]);
  });
});

function messageReceiveEffectsOf(
  effects: Effect[],
): Array<Extract<Effect, { type: "interaction" }>> {
  return effects.filter(
    (e): e is Extract<Effect, { type: "interaction" }> =>
      e.type === "interaction" && e.interaction.class === "message-receive",
  );
}

describe("sqs message-receive recognizer", () => {
  it("emits a message-receive interaction for JSON.parse(record.body) inside for-of(event.Records)", () => {
    const file = makeProject(`
      import type { SQSEvent } from "aws-lambda";
      export async function handler(event: SQSEvent): Promise<void> {
        for (const record of event.Records) {
          const { id, totalAmount } = JSON.parse(record.body);
          void id; void totalAmount;
        }
      }
    `);
    const receives = messageReceiveEffectsOf(recognizeAll(file));
    expect(receives).toHaveLength(1);
    const receive = receives[0] ?? raise("no receive effect");
    expect(receive.binding.semantics).toMatchObject({
      name: "message-bus",
      messageBus: "sqs",
      // Channel intentionally empty: pairing layer fills from CFN
      // consumer summary's binding via codeScope.
      channel: null,
    });
  });

  it("captures destructured field names as the interaction body shape", () => {
    const file = makeProject(`
      import type { SQSEvent } from "aws-lambda";
      export async function handler(event: SQSEvent): Promise<void> {
        for (const record of event.Records) {
          const { id, totalAmount } = JSON.parse(record.body);
          void id; void totalAmount;
        }
      }
    `);
    const receive =
      messageReceiveEffectsOf(recognizeAll(file))[0] ?? raise("no receive");
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
    const file = makeProject(`
      import type { SQSEvent } from "aws-lambda";
      export async function handler(event: SQSEvent): Promise<void> {
        for (const record of event.Records) {
          const order = JSON.parse(record.body);
          void order;
        }
      }
    `);
    const receives = messageReceiveEffectsOf(recognizeAll(file));
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
    const file = makeProject(`
      import type { SQSEvent } from "aws-lambda";
      export async function handler(event: SQSEvent): Promise<void> {
        for (const record of event.Records) {
          const { total: localAlias } = JSON.parse(record.body);
          void localAlias;
        }
      }
    `);
    const receive =
      messageReceiveEffectsOf(recognizeAll(file))[0] ?? raise("no receive");
    if (receive.interaction.class !== "message-receive") {
      throw new Error("wrong interaction class");
    }
    const body = receive.interaction.body as {
      fields: Record<string, unknown>;
    };
    expect(Object.keys(body.fields)).toEqual(["total"]);
  });

  it("ignores JSON.parse calls outside event.Records loops", () => {
    const file = makeProject(`
      export async function handler(input: string): Promise<unknown> {
        return JSON.parse(input);
      }
    `);
    expect(messageReceiveEffectsOf(recognizeAll(file))).toEqual([]);
  });

  it("ignores JSON.parse on non-.body access", () => {
    const file = makeProject(`
      import type { SQSEvent } from "aws-lambda";
      export async function handler(event: SQSEvent): Promise<void> {
        for (const record of event.Records) {
          const x = JSON.parse(record.messageId);
          void x;
        }
      }
    `);
    expect(messageReceiveEffectsOf(recognizeAll(file))).toEqual([]);
  });

  it("ignores parse calls that aren't JSON.parse", () => {
    const file = makeProject(`
      import type { SQSEvent } from "aws-lambda";
      const myParser = { parse: (_: string): unknown => null };
      export async function handler(event: SQSEvent): Promise<void> {
        for (const record of event.Records) {
          const x = myParser.parse(record.body);
          void x;
        }
      }
    `);
    expect(messageReceiveEffectsOf(recognizeAll(file))).toEqual([]);
  });

  it("handles `as` cast on the parse result without breaking destructuring extraction", () => {
    const file = makeProject(`
      import type { SQSEvent } from "aws-lambda";
      interface Order { id: string; total: number }
      export async function handler(event: SQSEvent): Promise<void> {
        for (const record of event.Records) {
          const { id, total } = JSON.parse(record.body) as Order;
          void id; void total;
        }
      }
    `);
    const receive =
      messageReceiveEffectsOf(recognizeAll(file))[0] ?? raise("no receive");
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
    expect(pack.invocationRecognizers).toHaveLength(2);
  });

  it("adds a recognizer and an import gate per configured producer", () => {
    const pack = sqsFramework(DISPATCHER_OPTIONS);
    expect(pack.invocationRecognizers).toHaveLength(4);
    expect(pack.requiresImport).toEqual([
      "@aws-sdk/client-sqs",
      "aws-lambda",
      "@acme/async",
    ]);
  });
});

describe("sqs configured producer", () => {
  it("reads a send on the project's own dispatcher", () => {
    const file = makeProject(`
      import { CommandDispatcher } from "@acme/async";
      export async function place(dispatcher: CommandDispatcher) {
        await dispatcher.dispatch(
          "order.placed",
          { orderId: "o-1", total: "9" },
          { queueUrl: process.env.ORDERS_QUEUE_URL }
        );
      }
    `);

    const sends = messageSendEffectsOf(recognizeAll(file, DISPATCHER_OPTIONS));
    expect(sends).toHaveLength(1);
    const send = sends[0];
    expect(send.binding.semantics).toEqual({
      name: "message-bus",
      messageBus: "sqs",
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

  it("reads nothing when the subject is computed", () => {
    const file = makeProject(`
      import { CommandDispatcher } from "@acme/async";
      export async function place(dispatcher: CommandDispatcher, kind: string) {
        await dispatcher.dispatch(kind, { orderId: "o-1" }, { queueUrl: "u" });
      }
    `);

    expect(
      messageSendEffectsOf(recognizeAll(file, DISPATCHER_OPTIONS)),
    ).toEqual([]);
  });

  it("carries no body for a batch method the config gives no body argument", () => {
    const file = makeProject(`
      import { CommandDispatcher } from "@acme/async";
      export async function placeMany(dispatcher: CommandDispatcher) {
        await dispatcher.dispatchBatch("order.placed", []);
      }
    `);

    const sends = messageSendEffectsOf(recognizeAll(file, DISPATCHER_OPTIONS));
    expect(sends).toHaveLength(1);
    if (sends[0].interaction.class !== "message-send") {
      throw new Error("wrong interaction class");
    }
    expect(sends[0].interaction.body).toBeUndefined();
    expect(sends[0].binding.semantics).toEqual({
      name: "message-bus",
      messageBus: "sqs",
      channel: "order.placed",
    });
  });

  it("reads nothing without the config, on the same source", () => {
    const file = makeProject(`
      import { CommandDispatcher } from "@acme/async";
      export async function place(dispatcher: CommandDispatcher) {
        await dispatcher.dispatch("order.placed", { orderId: "o-1" }, {});
      }
    `);

    expect(messageSendEffectsOf(recognizeAll(file))).toEqual([]);
  });
});
