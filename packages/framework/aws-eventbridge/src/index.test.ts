import {
  type CallExpression,
  Node,
  Project,
  ScriptTarget,
  type SourceFile,
} from "ts-morph";
import { describe, expect, it } from "vitest";

import { isImportedFrom } from "@suss/adapter-typescript";

import { eventBridgeFramework } from "./index.js";

import type { Effect } from "@suss/behavioral-ir";
import type { EffectArg } from "@suss/extractor";

const raise = (msg: string): never => {
  throw new Error(msg);
};

/**
 * Build an in-memory ts-morph Project with a fake
 * `@aws-sdk/client-eventbridge` .d.ts so the recognizer's import-source
 * check (`isImportedFrom`) has symbols to resolve against.
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

  project.createSourceFile(
    "node_modules/@aws-sdk/client-eventbridge/index.d.ts",
    `
export class EventBridgeClient {
  constructor(config?: unknown);
  send(command: unknown): Promise<unknown>;
}
export class PutEventsCommand {
  constructor(input: { Entries?: unknown[] });
}
`,
  );

  return project.createSourceFile("user.ts", userSource);
}

/**
 * Walk the source file and run the EventBridge recognizer on every
 * CallExpression. Returns the flat list of emitted effects.
 */
function recognizeAll(sourceFile: SourceFile): Effect[] {
  const pack = eventBridgeFramework();
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
 * EffectArg builder for tests — mirrors the adapter's extractArgs
 * enough for the EventBridge recognizer's needs (object / array /
 * string / identifier / new(...) / call shapes).
 */
function extractArgsForTest(call: CallExpression): EffectArg[] {
  return call.getArguments().map((arg) => extractArgForTest(arg));
}

function extractArgForTest(node: Node): EffectArg {
  if (Node.isAsExpression(node) || Node.isNonNullExpression(node)) {
    return extractArgForTest(node.getExpression());
  }
  if (Node.isStringLiteral(node)) {
    return { kind: "string", value: node.getLiteralValue() };
  }
  if (Node.isObjectLiteralExpression(node)) {
    const fields: Record<string, EffectArg> = {};
    for (const prop of node.getProperties()) {
      if (Node.isShorthandPropertyAssignment(prop)) {
        const nameNode = prop.getNameNode();
        if (Node.isIdentifier(nameNode)) {
          fields[nameNode.getText()] = {
            kind: "identifier",
            name: nameNode.getText(),
          };
        }
        continue;
      }
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
  if (Node.isArrayLiteralExpression(node)) {
    return {
      kind: "array",
      items: node.getElements().map((el) => extractArgForTest(el)),
    };
  }
  if (Node.isNewExpression(node) || Node.isCallExpression(node)) {
    return {
      kind: "call",
      callee: node.getExpression().getText(),
      args: node.getArguments().map((a) => extractArgForTest(a)),
    };
  }
  if (Node.isIdentifier(node) || Node.isPropertyAccessExpression(node)) {
    return { kind: "identifier", name: node.getText() };
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

function channelOf(effect: Extract<Effect, { type: "interaction" }>): string {
  const sem = effect.binding.semantics;
  return sem.name === "message-bus" ? sem.channel : raise("not message-bus");
}

describe("eventbridge recognizer — happy path", () => {
  it("emits one message-send per entry keyed on bus#detailType (env-derived bus)", () => {
    const file = makeProject(`
      import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
      const client = new EventBridgeClient({});
      async function publish(order: { id: string; total: number }) {
        await client.send(new PutEventsCommand({
          Entries: [{
            EventBusName: process.env.ORDER_EVENT_BUS_NAME,
            Source: "orders.service",
            DetailType: "OrderPlaced",
            Detail: JSON.stringify({ id: order.id, total: order.total }),
          }],
        }));
      }
    `);
    const sends = messageSendEffectsOf(recognizeAll(file));
    expect(sends).toHaveLength(1);
    const send = sends[0] ?? raise("no send effect");
    expect(send.binding.transport).toBe("eventbridge");
    expect(send.binding.semantics.name).toBe("message-bus");
    if (send.binding.semantics.name === "message-bus") {
      expect(send.binding.semantics.messageBus).toBe("eventbridge");
      expect(send.binding.semantics.channel).toBe(
        "ORDER_EVENT_BUS_NAME#OrderPlaced",
      );
    }
  });

  it("captures the Detail payload's inner object as the interaction body", () => {
    const file = makeProject(`
      import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
      const client = new EventBridgeClient({});
      async function publish(order: { id: string; total: number }) {
        await client.send(new PutEventsCommand({
          Entries: [{
            EventBusName: process.env.ORDER_EVENT_BUS_NAME,
            DetailType: "OrderPlaced",
            Detail: JSON.stringify({ id: order.id, total: order.total }),
          }],
        }));
      }
    `);
    const send =
      messageSendEffectsOf(recognizeAll(file))[0] ?? raise("no send");
    if (send.interaction.class !== "message-send") {
      throw new Error("wrong class");
    }
    const body = send.interaction.body as {
      kind?: string;
      fields?: Record<string, unknown>;
    };
    expect(body.kind).toBe("object");
    expect(Object.keys(body.fields ?? {}).sort()).toEqual(["id", "total"]);
  });

  it("records Source as the interaction routingKey", () => {
    const file = makeProject(`
      import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
      const client = new EventBridgeClient({});
      async function publish() {
        await client.send(new PutEventsCommand({
          Entries: [{
            EventBusName: process.env.ORDER_EVENT_BUS_NAME,
            Source: "orders.service",
            DetailType: "OrderPlaced",
            Detail: JSON.stringify({ id: "1" }),
          }],
        }));
      }
    `);
    const send =
      messageSendEffectsOf(recognizeAll(file))[0] ?? raise("no send");
    if (send.interaction.class !== "message-send") {
      throw new Error("wrong class");
    }
    expect(send.interaction.routingKey).toBe("orders.service");
  });

  it("emits one effect per entry in a multi-entry PutEvents", () => {
    const file = makeProject(`
      import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
      const client = new EventBridgeClient({});
      async function publish() {
        await client.send(new PutEventsCommand({
          Entries: [
            {
              EventBusName: process.env.ORDER_EVENT_BUS_NAME,
              DetailType: "OrderPlaced",
              Detail: JSON.stringify({ id: "1" }),
            },
            {
              EventBusName: process.env.ORDER_EVENT_BUS_NAME,
              DetailType: "OrderShipped",
              Detail: JSON.stringify({ id: "1" }),
            },
          ],
        }));
      }
    `);
    const sends = messageSendEffectsOf(recognizeAll(file));
    expect(sends.map(channelOf).sort()).toEqual([
      "ORDER_EVENT_BUS_NAME#OrderPlaced",
      "ORDER_EVENT_BUS_NAME#OrderShipped",
    ]);
  });

  it("handles a literal EventBusName", () => {
    const file = makeProject(`
      import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
      const client = new EventBridgeClient({});
      async function publish() {
        await client.send(new PutEventsCommand({
          Entries: [{
            EventBusName: "order-events",
            DetailType: "OrderPlaced",
            Detail: JSON.stringify({ id: "1" }),
          }],
        }));
      }
    `);
    const send =
      messageSendEffectsOf(recognizeAll(file))[0] ?? raise("no send");
    expect(channelOf(send)).toBe("order-events#OrderPlaced");
  });

  it('defaults the bus to "default" when EventBusName is omitted', () => {
    const file = makeProject(`
      import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
      const client = new EventBridgeClient({});
      async function publish() {
        await client.send(new PutEventsCommand({
          Entries: [{
            DetailType: "OrderPlaced",
            Detail: JSON.stringify({ id: "1" }),
          }],
        }));
      }
    `);
    const send =
      messageSendEffectsOf(recognizeAll(file))[0] ?? raise("no send");
    expect(channelOf(send)).toBe("default#OrderPlaced");
  });

  it("recognizes a namespace import", () => {
    const file = makeProject(`
      import * as eb from "@aws-sdk/client-eventbridge";
      const client = new eb.EventBridgeClient({});
      async function publish() {
        await client.send(new eb.PutEventsCommand({
          Entries: [{
            EventBusName: process.env.ORDER_EVENT_BUS_NAME,
            DetailType: "OrderPlaced",
            Detail: JSON.stringify({ id: "1" }),
          }],
        }));
      }
    `);
    const sends = messageSendEffectsOf(recognizeAll(file));
    expect(sends).toHaveLength(1);
    expect(channelOf(sends[0] ?? raise("no send"))).toBe(
      "ORDER_EVENT_BUS_NAME#OrderPlaced",
    );
  });
});

describe("eventbridge recognizer — skip cases", () => {
  it("skips an entry whose DetailType isn't a string literal", () => {
    const file = makeProject(`
      import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
      const client = new EventBridgeClient({});
      function detailTypeFor(): string { return "x"; }
      async function publish() {
        await client.send(new PutEventsCommand({
          Entries: [{
            EventBusName: process.env.ORDER_EVENT_BUS_NAME,
            DetailType: detailTypeFor(),
            Detail: JSON.stringify({ id: "1" }),
          }],
        }));
      }
    `);
    // Channel identity can't form without a literal DetailType → skipped.
    expect(messageSendEffectsOf(recognizeAll(file))).toEqual([]);
  });

  it("skips an entry whose EventBusName is a dynamic (non-env, non-literal) value", () => {
    const file = makeProject(`
      import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
      const client = new EventBridgeClient({});
      function busFor(): string { return "x"; }
      async function publish() {
        await client.send(new PutEventsCommand({
          Entries: [{
            EventBusName: busFor(),
            DetailType: "OrderPlaced",
            Detail: JSON.stringify({ id: "1" }),
          }],
        }));
      }
    `);
    expect(messageSendEffectsOf(recognizeAll(file))).toEqual([]);
  });

  it("keeps resolvable entries and drops unresolvable ones in the same call", () => {
    const file = makeProject(`
      import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
      const client = new EventBridgeClient({});
      function detailTypeFor(): string { return "x"; }
      async function publish() {
        await client.send(new PutEventsCommand({
          Entries: [
            {
              EventBusName: process.env.ORDER_EVENT_BUS_NAME,
              DetailType: "OrderPlaced",
              Detail: JSON.stringify({ id: "1" }),
            },
            {
              EventBusName: process.env.ORDER_EVENT_BUS_NAME,
              DetailType: detailTypeFor(),
              Detail: JSON.stringify({ id: "1" }),
            },
          ],
        }));
      }
    `);
    const sends = messageSendEffectsOf(recognizeAll(file));
    expect(sends.map(channelOf)).toEqual(["ORDER_EVENT_BUS_NAME#OrderPlaced"]);
  });

  it("ignores PutEventsCommand from the wrong module", () => {
    const file = makeProject(`
      class PutEventsCommand {
        constructor(public input: unknown) {}
      }
      const client = { send: async (c: unknown) => c };
      async function publish() {
        await client.send(new PutEventsCommand({
          Entries: [{ DetailType: "OrderPlaced", Detail: "{}" }],
        }));
      }
    `);
    expect(messageSendEffectsOf(recognizeAll(file))).toEqual([]);
  });

  it("ignores .send() with a non-EventBridge command class", () => {
    const file = makeProject(`
      class FakeCommand { constructor(public input: unknown) {} }
      const client = { send: async (c: unknown) => c };
      async function publish() {
        await client.send(new FakeCommand({ Entries: [] }));
      }
    `);
    expect(messageSendEffectsOf(recognizeAll(file))).toEqual([]);
  });

  it("returns null when Entries isn't an array literal", () => {
    const file = makeProject(`
      import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
      const client = new EventBridgeClient({});
      const entries = [{ DetailType: "OrderPlaced", Detail: "{}" }];
      async function publish() {
        await client.send(new PutEventsCommand({ Entries: entries }));
      }
    `);
    expect(messageSendEffectsOf(recognizeAll(file))).toEqual([]);
  });

  it("ignores method calls that aren't .send", () => {
    const file = makeProject(`
      import { PutEventsCommand } from "@aws-sdk/client-eventbridge";
      const command = new PutEventsCommand({
        Entries: [{ DetailType: "OrderPlaced", Detail: "{}" }],
      });
      async function noop() { return command; }
    `);
    expect(messageSendEffectsOf(recognizeAll(file))).toEqual([]);
  });
});

describe("eventbridge pack metadata", () => {
  it("declares recognizer-only pack identity gated on the SDK import", () => {
    const pack = eventBridgeFramework();
    expect(pack.name).toBe("eventbridge");
    expect(pack.protocol).toBe("eventbridge");
    expect(pack.discovery).toEqual([]);
    expect(pack.terminals).toEqual([]);
    expect(pack.requiresImport).toEqual(["@aws-sdk/client-eventbridge"]);
    expect(pack.invocationRecognizers).toHaveLength(1);
  });
});
