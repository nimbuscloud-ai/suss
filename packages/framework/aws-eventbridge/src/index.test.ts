import { describe, expect, it } from "vitest";

import { boundaryKey } from "@suss/ir-core";
import { interactionsOf, packUnderTest } from "@suss/pack-harness";

import { eventBridgeFramework } from "./index.js";

import type { Effect } from "@suss/behavioral-ir";

const raise = (msg: string): never => {
  throw new Error(msg);
};

const LIBRARY = {
  "@aws-sdk/client-eventbridge": `
export class EventBridgeClient {
  constructor(config?: unknown);
  send(command: unknown): Promise<unknown>;
}
export class PutEventsCommand {
  constructor(input: { Entries?: unknown[] });
}
`,
  // A project's own publisher, for the configured-producer tests.
  "@acme/async": `
export declare class EventPublisher {
  emit(subject: string, data: unknown, opts: unknown): Promise<void>;
}
`,
};

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

const recognizeAll = (
  source: string,
  options?: Parameters<typeof eventBridgeFramework>[0],
): Effect[] =>
  packUnderTest(eventBridgeFramework(options), { library: LIBRARY }).effectsIn(
    source,
  );

const messageSendEffectsOf = (effects: Effect[]) =>
  interactionsOf(effects, "message-send");

function channelOf(
  effect: Extract<Effect, { type: "interaction" }>,
): string | null {
  const sem = effect.binding.semantics;
  return sem.name === "message-bus" ? sem.channel : raise("not message-bus");
}

describe("eventbridge recognizer: happy path", () => {
  it("emits one message-send per entry keyed on bus#detailType (env-derived bus)", () => {
    const source = `
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
    `;
    const sends = messageSendEffectsOf(recognizeAll(source));
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
    const source = `
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
    `;
    const send =
      messageSendEffectsOf(recognizeAll(source))[0] ?? raise("no send");
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
    const source = `
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
    `;
    const send =
      messageSendEffectsOf(recognizeAll(source))[0] ?? raise("no send");
    if (send.interaction.class !== "message-send") {
      throw new Error("wrong class");
    }
    expect(send.interaction.routingKey).toBe("orders.service");
  });

  it("emits one effect per entry in a multi-entry PutEvents", () => {
    const source = `
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
    `;
    // Both puts are recorded. Only the one the code named can pair.
    const sends = messageSendEffectsOf(recognizeAll(source));
    expect(sends.map(channelOf).sort()).toEqual([
      "ORDER_EVENT_BUS_NAME#OrderPlaced",
      "ORDER_EVENT_BUS_NAME#OrderShipped",
    ]);
  });

  it("handles a literal EventBusName", () => {
    const source = `
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
    `;
    const send =
      messageSendEffectsOf(recognizeAll(source))[0] ?? raise("no send");
    expect(channelOf(send)).toBe("order-events#OrderPlaced");
  });

  it('defaults the bus to "default" when EventBusName is omitted', () => {
    const source = `
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
    `;
    const send =
      messageSendEffectsOf(recognizeAll(source))[0] ?? raise("no send");
    expect(channelOf(send)).toBe("default#OrderPlaced");
  });

  it("recognizes a namespace import", () => {
    const source = `
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
    `;
    // Both puts are recorded. Only the one the code named can pair.
    const sends = messageSendEffectsOf(recognizeAll(source));
    expect(sends).toHaveLength(1);
    expect(channelOf(sends[0] ?? raise("no send"))).toBe(
      "ORDER_EVENT_BUS_NAME#OrderPlaced",
    );
  });
});

describe("eventbridge recognizer: skip cases", () => {
  it("records an entry whose detail type is worked out at runtime", () => {
    const source = `
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
    `;
    // The put happened. What it cannot say is which detail type, so
    // that half is empty and the boundary pairs with nothing.
    const [effect] = messageSendEffectsOf(recognizeAll(source));
    const binding = effect?.binding ?? raise("no binding");
    expect(boundaryKey(binding)).toBeNull();
  });

  it("records an entry whose bus is worked out at runtime", () => {
    const source = `
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
    `;
    const [effect] = messageSendEffectsOf(recognizeAll(source));
    const binding = effect?.binding ?? raise("no binding");
    expect(boundaryKey(binding)).toBeNull();
  });

  it("records both entries when one of them names less than the other", () => {
    const source = `
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
    `;
    // Both puts are recorded. Only the one the code named can pair.
    const sends = messageSendEffectsOf(recognizeAll(source));
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
    const sends = messageSendEffectsOf(
      packUnderTest(eventBridgeFramework(), { library: LIBRARY }).effectsAcross(
        {
          "/events.ts": `export const ORDER_PLACED = "OrderPlaced";`,
          "/publish.ts": `
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
    `,
        },
        "/publish.ts",
      ),
    );
    expect(sends.map(channelOf)).toEqual(["BUS_NAME#OrderPlaced"]);
  });

  it("ignores PutEventsCommand from the wrong module", () => {
    const source = `
      class PutEventsCommand {
        constructor(public input: unknown) {}
      }
      const client = { send: async (c: unknown) => c };
      async function publish() {
        await client.send(new PutEventsCommand({
          Entries: [{ DetailType: "OrderPlaced", Detail: "{}" }],
        }));
      }
    `;
    expect(messageSendEffectsOf(recognizeAll(source))).toEqual([]);
  });

  it("ignores .send() with a non-EventBridge command class", () => {
    const source = `
      class FakeCommand { constructor(public input: unknown) {} }
      const client = { send: async (c: unknown) => c };
      async function publish() {
        await client.send(new FakeCommand({ Entries: [] }));
      }
    `;
    expect(messageSendEffectsOf(recognizeAll(source))).toEqual([]);
  });

  it("returns null when a function builds the entries", () => {
    const source = `
      import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
      const client = new EventBridgeClient({});
      declare function buildEntries(): unknown[];
      async function publish() {
        await client.send(new PutEventsCommand({ Entries: buildEntries() }));
      }
    `;
    expect(messageSendEffectsOf(recognizeAll(source))).toEqual([]);
  });

  it("returns null when the entries arrive as a parameter", () => {
    const source = `
      import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
      const client = new EventBridgeClient({});
      async function publish(entries: unknown[]) {
        await client.send(new PutEventsCommand({ Entries: entries }));
      }
    `;
    expect(messageSendEffectsOf(recognizeAll(source))).toEqual([]);
  });

  it("reads entries a const states, since extraction follows it", () => {
    // The old test here passed a const with an array literal and
    // expected nothing, which only held because this file built its own
    // arguments and stopped at the identifier. Extraction follows the
    // const, so the send is there.
    const source = `
      import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
      const client = new EventBridgeClient({});
      const entries = [{ DetailType: "OrderPlaced", Detail: "{}" }];
      async function publish() {
        await client.send(new PutEventsCommand({ Entries: entries }));
      }
    `;
    expect(messageSendEffectsOf(recognizeAll(source)).map(channelOf)).toEqual([
      "default#OrderPlaced",
    ]);
  });

  it("ignores method calls that aren't .send", () => {
    const source = `
      import { PutEventsCommand } from "@aws-sdk/client-eventbridge";
      const command = new PutEventsCommand({
        Entries: [{ DetailType: "OrderPlaced", Detail: "{}" }],
      });
      async function noop() { return command; }
    `;
    expect(messageSendEffectsOf(recognizeAll(source))).toEqual([]);
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
    const source = `
      import { EventPublisher } from "@acme/async";
      export async function announce(publisher: EventPublisher) {
        await publisher.emit(
          "user.deleted",
          { userId: "u-1" },
          { partitionKey: "u-1" }
        );
      }
    `;

    const sends = messageSendEffectsOf(recognizeAll(source, PUBLISHER_OPTIONS));
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
    const source = `
      import { EventPublisher } from "@acme/async";
      export async function announce(publisher: EventPublisher, kind: string) {
        await publisher.emit(kind, { userId: "u-1" }, { partitionKey: "u-1" });
      }
    `;

    expect(
      messageSendEffectsOf(recognizeAll(source, PUBLISHER_OPTIONS)),
    ).toEqual([]);
  });

  it("reads nothing without the config, on the same source", () => {
    const source = `
      import { EventPublisher } from "@acme/async";
      export async function announce(publisher: EventPublisher) {
        await publisher.emit("user.deleted", { userId: "u-1" }, {});
      }
    `;

    expect(messageSendEffectsOf(recognizeAll(source))).toEqual([]);
  });
});
