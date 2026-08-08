import { type CallExpression, Node, type SourceFile } from "ts-morph";
import { describe, expect, it } from "vitest";

import { isImportedFrom, ResolutionStore } from "@suss/adapter-typescript";
import { boundaryKey } from "@suss/ir-core";
import { createTestProject } from "@suss/test-project";

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
  const project = createTestProject();

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

  // A project's own publisher, for the configured-producer tests.
  project.createSourceFile(
    "node_modules/@acme/async/package.json",
    JSON.stringify({ name: "@acme/async", types: "index.d.ts" }),
  );
  project.createSourceFile(
    "node_modules/@acme/async/index.d.ts",
    `
export declare class EventPublisher {
  emit(subject: string, data: unknown, opts: unknown): Promise<void>;
}
`,
  );

  return project.createSourceFile("user.ts", userSource);
}

/** The publisher config the configured-producer tests run with. */
const PUBLISHER_OPTIONS = {
  producers: [
    {
      module: "@acme/async",
      receiver: "EventPublisher",
      method: "emit",
      subjectArg: 0,
      bodyArg: 1,
    },
  ],
};

/**
 * Walk the source file and run the EventBridge recognizer on every
 * CallExpression. Returns the flat list of emitted effects.
 */
function recognizeAll(
  sourceFile: SourceFile,
  options?: Parameters<typeof eventBridgeFramework>[0],
): Effect[] {
  const pack = eventBridgeFramework(options);
  const recognizers = pack.invocationRecognizers ?? [];
  if (recognizers.length === 0) {
    return raise("expected pack to declare invocationRecognizers");
  }
  const effects: Effect[] = [];
  const store = new ResolutionStore([]);
  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) {
      return;
    }
    const ctx = {
      call: node as CallExpression,
      sourceFile,
      extractArgs: (): EffectArg[] => extractArgsForTest(node),
      isImportedFrom,
      resolveWrittenValue: (value: Node) => store.resolveWrittenValue(value),
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
 * An EffectArg builder for tests, mirroring the adapter's extractArgs closely
 * enough for what the EventBridge recognizer needs: object, array, string,
 * identifier, `new (...)`, and call forms.
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

function channelOf(
  effect: Extract<Effect, { type: "interaction" }>,
): string | null {
  const sem = effect.binding.semantics;
  return sem.name === "message-bus" ? sem.channel : raise("not message-bus");
}

describe("eventbridge recognizer: happy path", () => {
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
    // Both puts are recorded. Only the one the code named can pair.
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
    // Both puts are recorded. Only the one the code named can pair.
    const sends = messageSendEffectsOf(recognizeAll(file));
    expect(sends).toHaveLength(1);
    expect(channelOf(sends[0] ?? raise("no send"))).toBe(
      "ORDER_EVENT_BUS_NAME#OrderPlaced",
    );
  });
});

describe("eventbridge recognizer: skip cases", () => {
  it("records an entry whose detail type is worked out at runtime", () => {
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
    // The put happened. What it cannot say is which detail type, so
    // that half is empty and the boundary pairs with nothing.
    const [effect] = messageSendEffectsOf(recognizeAll(file));
    const binding = effect?.binding ?? raise("no binding");
    expect(boundaryKey(binding)).toBeNull();
  });

  it("records an entry whose bus is worked out at runtime", () => {
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
    const [effect] = messageSendEffectsOf(recognizeAll(file));
    const binding = effect?.binding ?? raise("no binding");
    expect(boundaryKey(binding)).toBeNull();
  });

  it("records both entries when one of them names less than the other", () => {
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
    // Both puts are recorded. Only the one the code named can pair.
    const sends = messageSendEffectsOf(recognizeAll(file));
    expect(sends.map(channelOf)).toEqual([
      "ORDER_EVENT_BUS_NAME#OrderPlaced",
      null,
    ]);
    expect(sends.map((send) => boundaryKey(send.binding) !== null)).toEqual([
      true,
      false,
    ]);
  });

  it("names a detail type held in a const one import away", () => {
    const file = makeProject(`
      import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
      import { ORDER_PLACED } from "./events";
      const client = new EventBridgeClient({});
      export async function publish(id: string) {
        await client.send(new PutEventsCommand({
          Entries: [{
            EventBusName: process.env.BUS_NAME,
            DetailType: ORDER_PLACED,
            Detail: JSON.stringify({ id }),
          }],
        }));
      }
    `);
    file
      .getProject()
      .createSourceFile(
        "events.ts",
        `export const ORDER_PLACED = "OrderPlaced";`,
      );

    const sends = messageSendEffectsOf(recognizeAll(file));
    expect(sends.map(channelOf)).toEqual(["BUS_NAME#OrderPlaced"]);
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

  it("adds a recognizer and an import gate per configured producer", () => {
    const pack = eventBridgeFramework(PUBLISHER_OPTIONS);
    expect(pack.invocationRecognizers).toHaveLength(2);
    expect(pack.requiresImport).toEqual([
      "@aws-sdk/client-eventbridge",
      "@acme/async",
    ]);
  });
});

describe("eventbridge configured producer", () => {
  it("reads a publish on the project's own publisher", () => {
    const file = makeProject(`
      import { EventPublisher } from "@acme/async";
      export async function announce(publisher: EventPublisher) {
        await publisher.emit(
          "user.deleted",
          { userId: "u-1" },
          { partitionKey: "u-1" }
        );
      }
    `);

    const sends = messageSendEffectsOf(recognizeAll(file, PUBLISHER_OPTIONS));
    expect(sends).toHaveLength(1);
    const send = sends[0];
    // No bus segment: the publisher takes its bus from constructor
    // config the call site never states, and a channel with no bus
    // agrees with any bus on the declared side.
    expect(send.binding.semantics).toEqual({
      name: "message-bus",
      messageBus: "eventbridge",
      channel: "user.deleted",
    });
    expect(send.binding.recognition).toBe("@suss/framework-aws-eventbridge");
    expect(send.callee).toBe("publisher.emit");
    if (send.interaction.class !== "message-send") {
      throw new Error("wrong interaction class");
    }
    expect(send.interaction.body).toEqual({
      kind: "object",
      fields: { userId: { kind: "string", value: "u-1" } },
    });
  });

  it("reads nothing when the subject is computed", () => {
    const file = makeProject(`
      import { EventPublisher } from "@acme/async";
      export async function announce(publisher: EventPublisher, kind: string) {
        await publisher.emit(kind, { userId: "u-1" }, { partitionKey: "u-1" });
      }
    `);

    expect(messageSendEffectsOf(recognizeAll(file, PUBLISHER_OPTIONS))).toEqual(
      [],
    );
  });

  it("reads nothing without the config, on the same source", () => {
    const file = makeProject(`
      import { EventPublisher } from "@acme/async";
      export async function announce(publisher: EventPublisher) {
        await publisher.emit("user.deleted", { userId: "u-1" }, {});
      }
    `);

    expect(messageSendEffectsOf(recognizeAll(file))).toEqual([]);
  });
});
