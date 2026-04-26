import {
  type CallExpression,
  Node,
  Project,
  ScriptTarget,
  type SourceFile,
} from "ts-morph";
import { describe, expect, it } from "vitest";

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
  const project = new Project({
    compilerOptions: {
      target: ScriptTarget.ES2022,
      strict: true,
      moduleResolution: 100, // ts.ModuleResolutionKind.Bundler
    },
    useInMemoryFileSystem: true,
  });

  // Minimal fake @aws-sdk/client-sqs surface — enough for the
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

  // Minimal fake aws-lambda types — for the consumer-side
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

  return project.createSourceFile("user.ts", userSource);
}

/**
 * Walk the source file and run the SQS recognizer on every CallExpression.
 * Returns the flat list of emitted effects.
 *
 * Not using the adapter's runInvocationRecognizers here because that
 * would pull the adapter as a dependency for unit tests — these tests
 * exercise the recognizer in isolation.
 */
function recognizeAll(sourceFile: SourceFile): Effect[] {
  const pack = sqsFramework();
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
 * Tiny EffectArg builder for tests — handles object/string/identifier/
 * new(...) shapes the recognizer reads. Mirrors the adapter's extractArgs
 * just enough for the SQS recognizer's needs.
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

describe("sqs recognizer — happy path", () => {
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

describe("sqs recognizer — rejection cases", () => {
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
        // Constructed but not sent — no .send call.
        return command;
      }
    `);
    expect(messageSendEffectsOf(recognizeAll(file))).toEqual([]);
  });

  it("returns null when QueueUrl uses an unrecognized shape", () => {
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
    // Call doesn't pair without channel identity → recognizer skips it.
    expect(messageSendEffectsOf(recognizeAll(file))).toEqual([]);
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
      channel: "",
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
    // const { total: localAlias } — `total` is the property the
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
});
