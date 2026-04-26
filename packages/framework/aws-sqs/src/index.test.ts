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
  const recognizer = pack.invocationRecognizers?.[0];
  if (recognizer === undefined) {
    return raise("expected pack to declare an invocationRecognizer");
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
    const emitted = recognizer(node, ctx);
    if (emitted !== null) {
      effects.push(...emitted);
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

describe("sqs pack metadata", () => {
  it("declares correct pack identity (no discovery, no terminals, recognizer present)", () => {
    const pack = sqsFramework();
    expect(pack.name).toBe("sqs");
    expect(pack.protocol).toBe("sqs");
    expect(pack.discovery).toEqual([]);
    expect(pack.terminals).toEqual([]);
    expect(pack.invocationRecognizers).toHaveLength(1);
  });
});
