// Unit tests for the body-shape pairing pass in checkMessageBus.
//
// Wiring-finding paths (orphan / unused) are exercised by the
// CLI's awsSqsIntegration end-to-end test against the real fixture;
// these tests focus on the body-shape branches with hand-built
// summaries so the coverage threshold doesn't drift on us silently.

import { describe, expect, it } from "vitest";

import { checkAll } from "../index.js";
import { checkMessageBus } from "./messageBusPairing.js";

import type { BehavioralSummary, Effect } from "@suss/behavioral-ir";

function emptyTransition(id: string, effects: Effect[] = []) {
  return {
    id,
    conditions: [],
    output: { type: "void" } as const,
    effects,
    location: { start: 0, end: 0 },
    isDefault: true,
  };
}

function consumerSummary(opts: {
  name: string;
  channel: string;
  codeScopePath: string;
  /** Queue logical id kept in metadata when the channel is a subject. */
  queue?: string;
}): BehavioralSummary {
  return {
    kind: "consumer",
    location: {
      file: "template.yaml",
      range: { start: 0, end: 0 },
      exportName: null,
    },
    identity: {
      name: opts.name,
      exportPath: null,
      boundaryBinding: {
        transport: "sqs",
        semantics: {
          name: "message-bus",
          messageBus: "sqs",
          channel: opts.channel,
        },
        recognition: "@suss/contract-cloudformation",
      },
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
    metadata: {
      codeScope: { kind: "codeUri", path: opts.codeScopePath },
      ...(opts.queue !== undefined
        ? { messageBus: { queue: opts.queue } }
        : {}),
    },
  };
}

function producerSummary(opts: {
  name: string;
  filePath: string;
  /** Null models a send whose queue the code names at runtime. */
  channel: string | null;
  bodyFields?: string[] | null;
  messageBus?: "sqs" | "eventbridge";
}): BehavioralSummary {
  const body =
    opts.bodyFields === null
      ? undefined
      : opts.bodyFields !== undefined
        ? {
            kind: "object" as const,
            fields: Object.fromEntries(
              opts.bodyFields.map((f) => [
                f,
                { kind: "identifier" as const, name: f },
              ]),
            ),
          }
        : undefined;
  const sendEffect: Effect = {
    type: "interaction",
    binding: {
      transport: "sqs",
      semantics: {
        name: "message-bus",
        messageBus: opts.messageBus ?? "sqs",
        channel: opts.channel,
      },
      recognition: "@suss/framework-aws-sqs",
    },
    interaction: {
      class: "message-send",
      ...(body !== undefined ? { body } : {}),
    },
  };
  return {
    kind: "handler",
    location: {
      file: opts.filePath,
      range: { start: 0, end: 0 },
      exportName: "handler",
    },
    identity: {
      name: opts.name,
      exportPath: null,
      boundaryBinding: null,
    },
    inputs: [],
    transitions: [emptyTransition("t-0", [sendEffect])],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

function consumerCodeSummary(opts: {
  name: string;
  filePath: string;
  bodyFields: string[];
}): BehavioralSummary {
  const receiveEffect: Effect = {
    type: "interaction",
    binding: {
      transport: "sqs",
      semantics: {
        name: "message-bus",
        messageBus: "sqs",
        // The queue a handler drains is stated by the event-source
        // mapping, so the receive effect does not name it.
        channel: null,
      },
      recognition: "@suss/framework-aws-sqs",
    },
    interaction: {
      class: "message-receive",
      body: {
        kind: "object",
        fields: Object.fromEntries(
          opts.bodyFields.map((f) => [f, { kind: "identifier", name: f }]),
        ),
      },
    },
  };
  return {
    kind: "handler",
    location: {
      file: opts.filePath,
      range: { start: 0, end: 0 },
      exportName: "handler",
    },
    identity: {
      name: opts.name,
      exportPath: null,
      boundaryBinding: null,
    },
    inputs: [],
    transitions: [emptyTransition("t-0", [receiveEffect])],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

function queueProvider(channel: string): BehavioralSummary {
  return {
    kind: "library",
    location: {
      file: "template.yaml",
      range: { start: 0, end: 0 },
      exportName: null,
    },
    identity: {
      name: channel,
      exportPath: null,
      boundaryBinding: {
        transport: "sqs",
        semantics: {
          name: "message-bus",
          messageBus: "sqs",
          channel,
        },
        recognition: "@suss/contract-cloudformation",
      },
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
  };
}

describe("body-shape pairing", () => {
  it("emits boundaryFieldUnknown (aspect: receive) when consumer reads a field producer doesn't send", () => {
    const summaries = [
      queueProvider("OrdersQueue"),
      producerSummary({
        name: "OrderProducer",
        filePath: "src/order-producer/index.ts",
        channel: "OrdersQueue",
        bodyFields: ["id", "total"],
      }),
      consumerSummary({
        name: "OrderConsumer",
        channel: "OrdersQueue",
        codeScopePath: "src/order-consumer/",
      }),
      consumerCodeSummary({
        name: "handler",
        filePath: "src/order-consumer/index.ts",
        bodyFields: ["id", "totalAmount"],
      }),
    ];
    const findings = checkMessageBus(summaries);
    const bodyMismatches = findings.filter(
      (f) => f.kind === "boundaryFieldUnknown" && f.aspect === "receive",
    );
    expect(bodyMismatches).toHaveLength(1);
    expect(bodyMismatches[0]?.description).toContain("totalAmount");
    expect(bodyMismatches[0]?.severity).toBe("warning");
  });

  it("emits NO body-shape finding when producer and consumer field sets agree", () => {
    const summaries = [
      queueProvider("OrdersQueue"),
      producerSummary({
        name: "OrderProducer",
        filePath: "src/order-producer/index.ts",
        channel: "OrdersQueue",
        bodyFields: ["id", "total"],
      }),
      consumerSummary({
        name: "OrderConsumer",
        channel: "OrdersQueue",
        codeScopePath: "src/order-consumer/",
      }),
      consumerCodeSummary({
        name: "handler",
        filePath: "src/order-consumer/index.ts",
        bodyFields: ["id", "total"],
      }),
    ];
    const findings = checkMessageBus(summaries);
    expect(
      findings.filter(
        (f) => f.kind === "boundaryFieldUnknown" && f.aspect === "receive",
      ),
    ).toEqual([]);
  });

  it("skips body-shape pairing when producer's body is opaque (no extractable fields)", () => {
    const summaries = [
      queueProvider("OrdersQueue"),
      producerSummary({
        name: "OrderProducer",
        filePath: "src/order-producer/index.ts",
        channel: "OrdersQueue",
        bodyFields: null, // opaque — `JSON.stringify(event.order)` style
      }),
      consumerSummary({
        name: "OrderConsumer",
        channel: "OrdersQueue",
        codeScopePath: "src/order-consumer/",
      }),
      consumerCodeSummary({
        name: "handler",
        filePath: "src/order-consumer/index.ts",
        bodyFields: ["whatever"],
      }),
    ];
    const findings = checkMessageBus(summaries);
    expect(
      findings.filter(
        (f) => f.kind === "boundaryFieldUnknown" && f.aspect === "receive",
      ),
    ).toEqual([]);
  });

  it("skips body-shape pairing when consumer summary has no codeScope", () => {
    const consumer = consumerSummary({
      name: "OrderConsumer",
      channel: "OrdersQueue",
      codeScopePath: "src/order-consumer/",
    });
    consumer.metadata = {}; // no codeScope
    const summaries = [
      queueProvider("OrdersQueue"),
      producerSummary({
        name: "OrderProducer",
        filePath: "src/order-producer/index.ts",
        channel: "OrdersQueue",
        bodyFields: ["id", "total"],
      }),
      consumer,
      consumerCodeSummary({
        name: "handler",
        filePath: "src/order-consumer/index.ts",
        bodyFields: ["nonexistent"],
      }),
    ];
    const findings = checkMessageBus(summaries);
    expect(
      findings.filter(
        (f) => f.kind === "boundaryFieldUnknown" && f.aspect === "receive",
      ),
    ).toEqual([]);
  });

  it("emits NO body-shape finding when consumer code scope contains no message-receive effects", () => {
    const summaries = [
      queueProvider("OrdersQueue"),
      producerSummary({
        name: "OrderProducer",
        filePath: "src/order-producer/index.ts",
        channel: "OrdersQueue",
        bodyFields: ["id", "total"],
      }),
      consumerSummary({
        name: "OrderConsumer",
        channel: "OrdersQueue",
        codeScopePath: "src/empty-consumer/",
      }),
    ];
    const findings = checkMessageBus(summaries);
    expect(
      findings.filter(
        (f) => f.kind === "boundaryFieldUnknown" && f.aspect === "receive",
      ),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// EventBridge pairing
// ---------------------------------------------------------------------------

function eventBridgeProducer(opts: {
  name: string;
  filePath: string;
  channel: string;
}): BehavioralSummary {
  const sendEffect: Effect = {
    type: "interaction",
    binding: {
      transport: "eventbridge",
      semantics: {
        name: "message-bus",
        messageBus: "eventbridge",
        channel: opts.channel,
      },
      recognition: "@suss/framework-aws-eventbridge",
    },
    interaction: { class: "message-send" },
  };
  return {
    kind: "handler",
    location: {
      file: opts.filePath,
      range: { start: 0, end: 0 },
      exportName: "handler",
    },
    identity: { name: opts.name, exportPath: null, boundaryBinding: null },
    inputs: [],
    transitions: [emptyTransition("t-0", [sendEffect])],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

function eventBridgeProvider(channel: string): BehavioralSummary {
  return {
    kind: "library",
    location: {
      file: "template.yaml",
      range: { start: 0, end: 0 },
      exportName: null,
    },
    identity: {
      name: channel,
      exportPath: null,
      boundaryBinding: {
        transport: "eventbridge",
        semantics: {
          name: "message-bus",
          messageBus: "eventbridge",
          channel,
        },
        recognition: "cloudformation",
      },
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
  };
}

function eventBridgeConsumer(opts: {
  name: string;
  channel: string;
  patternResolution: "exact" | "schedule" | "unresolvable";
  rule?: string;
  eventBus?: string;
  unresolvableReason?: string;
}): BehavioralSummary {
  return {
    kind: "consumer",
    location: {
      file: "template.yaml",
      range: { start: 0, end: 0 },
      exportName: null,
    },
    identity: {
      name: opts.name,
      exportPath: null,
      boundaryBinding: {
        transport: "eventbridge",
        semantics: {
          name: "message-bus",
          messageBus: "eventbridge",
          channel: opts.channel,
        },
        recognition: "cloudformation",
      },
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: {
      messageBus: {
        patternResolution: opts.patternResolution,
        ...(opts.rule !== undefined ? { rule: opts.rule } : {}),
        ...(opts.eventBus !== undefined ? { eventBus: opts.eventBus } : {}),
        ...(opts.unresolvableReason !== undefined
          ? { unresolvableReason: opts.unresolvableReason }
          : {}),
      },
    },
  };
}

function runtimeConfigProvider(opts: {
  instanceName: string;
  codeScopePath: string;
  envVarTargets: Record<string, { kind: "ref"; logicalId: string }>;
}): BehavioralSummary {
  return {
    kind: "library",
    location: {
      file: "template.yaml",
      range: { start: 0, end: 0 },
      exportName: null,
    },
    identity: {
      name: opts.instanceName,
      exportPath: null,
      boundaryBinding: {
        transport: "runtime-config",
        semantics: {
          name: "runtime-config",
          deploymentTarget: "lambda",
          instanceName: opts.instanceName,
        },
        recognition: "cloudformation",
      },
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: {
      codeScope: { kind: "codeUri", path: opts.codeScopePath },
      runtimeContract: {
        envVars: Object.keys(opts.envVarTargets),
        envVarTargets: opts.envVarTargets,
      },
    },
  };
}

describe("eventbridge pairing", () => {
  it("chain-collapses an env-derived bus so the producer pairs against the rule provider", () => {
    const summaries = [
      eventBridgeProvider("OrderEventBus#OrderPlaced"),
      eventBridgeConsumer({
        name: "OrderConsumer#OrderPlaced",
        channel: "OrderEventBus#OrderPlaced",
        patternResolution: "exact",
      }),
      eventBridgeProducer({
        name: "OrderProducer",
        filePath: "src/order-producer/index.ts",
        channel: "ORDER_EVENT_BUS_NAME#OrderPlaced",
      }),
      runtimeConfigProvider({
        instanceName: "OrderProducer",
        codeScopePath: "src/order-producer/",
        envVarTargets: {
          ORDER_EVENT_BUS_NAME: { kind: "ref", logicalId: "OrderEventBus" },
        },
      }),
    ];
    const findings = checkMessageBus(summaries);
    expect(
      findings.filter((f) => f.kind === "messageBusProducerOrphan"),
    ).toEqual([]);
    expect(
      findings.filter((f) => f.kind === "messageBusConsumerOrphan"),
    ).toEqual([]);
  });

  it("flags an orphan producer when the env-derived bus can't chain-collapse", () => {
    const summaries = [
      eventBridgeProvider("OrderEventBus#OrderPlaced"),
      eventBridgeProducer({
        name: "OrderProducer",
        filePath: "src/order-producer/index.ts",
        channel: "ORDER_EVENT_BUS_NAME#OrderPlaced",
      }),
      // No runtime-config provider → env var stays unresolved.
    ];
    const findings = checkMessageBus(summaries);
    const orphan = findings.find((f) => f.kind === "messageBusProducerOrphan");
    expect(orphan).toBeDefined();
    expect(orphan?.description).toContain("ORDER_EVENT_BUS_NAME");
  });

  it("flags a consumer orphan for a routed detailType no producer sends", () => {
    const summaries = [
      eventBridgeProvider("OrderEventBus#OrderShipped"),
      eventBridgeConsumer({
        name: "OrderConsumer#OrderShipped",
        channel: "OrderEventBus#OrderShipped",
        patternResolution: "exact",
      }),
    ];
    const findings = checkMessageBus(summaries);
    const orphan = findings.find((f) => f.kind === "messageBusConsumerOrphan");
    expect(orphan).toBeDefined();
    expect(orphan?.boundary.semantics.name).toBe("message-bus");
    if (orphan?.boundary.semantics.name === "message-bus") {
      expect(orphan.boundary.semantics.channel).toBe(
        "OrderEventBus#OrderShipped",
      );
    }
  });

  it("surfaces an unresolvable rule as unsupportedSemantics (info), not an orphan", () => {
    const summaries = [
      eventBridgeConsumer({
        name: "AuditConsumer.OnAnyOrderChange",
        channel: "OrderEventBus#<unresolved>",
        patternResolution: "unresolvable",
        rule: "AuditConsumer.OnAnyOrderChange",
        eventBus: "OrderEventBus",
        unresolvableReason: "detail-type contains a content filter",
      }),
    ];
    const findings = checkMessageBus(summaries);
    const unresolvable = findings.find(
      (f) => f.kind === "unsupportedSemantics",
    );
    expect(unresolvable).toBeDefined();
    expect(unresolvable?.severity).toBe("info");
    expect(unresolvable?.description).toContain(
      "AuditConsumer.OnAnyOrderChange",
    );
    // Not double-reported as a consumer orphan.
    expect(
      findings.filter((f) => f.kind === "messageBusConsumerOrphan"),
    ).toEqual([]);
  });

  it("does not flag a scheduled consumer as an orphan", () => {
    const summaries = [
      eventBridgeConsumer({
        name: "DigestFunction.DailyDigest",
        channel: "schedule:DigestFunction.DailyDigest",
        patternResolution: "schedule",
      }),
    ];
    const findings = checkMessageBus(summaries);
    expect(
      findings.filter((f) => f.kind === "messageBusConsumerOrphan"),
    ).toEqual([]);
    expect(findings.filter((f) => f.kind === "unsupportedSemantics")).toEqual(
      [],
    );
  });
});

/**
 * A code unit the aws-lambda pack bound to the subject its handler
 * factory names: a handler-kind summary carrying a message-bus binding
 * rather than a declared subscription.
 */
function codeReceiver(opts: {
  name: string;
  filePath: string;
  channel: string;
}): BehavioralSummary {
  return {
    kind: "handler",
    location: {
      file: opts.filePath,
      range: { start: 0, end: 0 },
      exportName: "handler",
    },
    identity: {
      name: opts.name,
      exportPath: null,
      boundaryBinding: {
        transport: "sqs",
        semantics: {
          name: "message-bus",
          messageBus: "sqs",
          channel: opts.channel,
        },
        recognition: "@suss/framework-aws-lambda",
      },
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

describe("code-side receivers", () => {
  it("stops a declared channel a handler answers being reported unused", () => {
    const summaries = [
      eventBridgeProvider("default#order.placed"),
      codeReceiver({
        name: "OrderProcessor.handler",
        filePath: "src/order-processor/index.ts",
        channel: "order.placed",
      }),
    ];
    const findings = checkMessageBus(summaries);
    expect(findings.filter((f) => f.kind === "messageBusUnused")).toHaveLength(
      0,
    );
  });

  it("still reports a declared channel no handler answers as unused", () => {
    const summaries = [
      eventBridgeProvider("default#order.placed"),
      codeReceiver({
        name: "ShipmentProcessor.handler",
        filePath: "src/shipment-processor/index.ts",
        channel: "shipment.created",
      }),
    ];
    const findings = checkMessageBus(summaries);
    expect(findings.filter((f) => f.kind === "messageBusUnused")).toHaveLength(
      1,
    );
  });

  it("does not orphan-check a code receiver that no producer sends to", () => {
    const summaries = [
      codeReceiver({
        name: "OrderProcessor.handler",
        filePath: "src/order-processor/index.ts",
        channel: "order.placed",
      }),
    ];
    const findings = checkMessageBus(summaries);
    expect(findings).toHaveLength(0);
  });
});

describe("subject-channelled consumers", () => {
  it("does not report the drained queue as unused when the consumer's channel is a subject", () => {
    const summaries = [
      queueProvider("OrdersQueue"),
      consumerSummary({
        name: "OrderProcessor.FromOrders",
        channel: "order.placed",
        codeScopePath: "src/order-processor/",
        queue: "OrdersQueue",
      }),
    ];
    const findings = checkMessageBus(summaries);
    expect(findings.filter((f) => f.kind === "messageBusUnused")).toHaveLength(
      0,
    );
  });

  it("does not orphan a rule-fed consumer when a producer publishes its subject", () => {
    const summaries = [
      queueProvider("OrdersQueue"),
      producerSummary({
        name: "OrderPublisher",
        filePath: "src/api/index.ts",
        channel: "AppBus#order.placed",
      }),
      consumerSummary({
        name: "OrderProcessor.FromOrders",
        channel: "AppBus#order.placed",
        codeScopePath: "src/order-processor/",
        queue: "OrdersQueue",
      }),
    ];
    const findings = checkMessageBus(summaries);
    expect(
      findings.filter(
        (f) =>
          f.kind === "messageBusConsumerOrphan" ||
          f.kind === "messageBusUnused",
      ),
    ).toHaveLength(0);
  });

  it("does not orphan a producer whose subject a consumer answers", () => {
    // A wrapper names the subject and the template names the queue, so
    // no provider carries the subject as its channel. The handler bound
    // to that subject is what says the channel exists.
    const summaries = [
      queueProvider("OrdersQueue"),
      producerSummary({
        name: "OrderPublisher",
        filePath: "src/api/index.ts",
        channel: "order.placed",
      }),
      consumerSummary({
        name: "OrderProcessor.FromOrders",
        channel: "order.placed",
        codeScopePath: "src/order-processor/",
        queue: "OrdersQueue",
      }),
    ];
    const findings = checkMessageBus(summaries);
    expect(
      findings.filter((f) => f.kind === "messageBusProducerOrphan"),
    ).toHaveLength(0);
  });

  it("still orphans a producer nothing declares and nothing answers", () => {
    const summaries = [
      queueProvider("OrdersQueue"),
      producerSummary({
        name: "OrderPublisher",
        filePath: "src/api/index.ts",
        channel: "order.misspelled",
      }),
      consumerSummary({
        name: "OrderProcessor.FromOrders",
        channel: "order.placed",
        codeScopePath: "src/order-processor/",
        queue: "OrdersQueue",
      }),
    ];
    const findings = checkMessageBus(summaries);
    const orphans = findings.filter(
      (f) => f.kind === "messageBusProducerOrphan",
    );
    expect(orphans).toHaveLength(1);
    expect(orphans[0].description).toContain("order.misspelled");
  });

  it("pairs a consumer that knows only its subject with a producer that names a bus", () => {
    const summaries = [
      queueProvider("OrdersQueue"),
      producerSummary({
        name: "OrderPublisher",
        filePath: "src/api/index.ts",
        channel: "default#order.placed",
      }),
      consumerSummary({
        name: "OrderProcessor.FromOrders",
        channel: "order.placed",
        codeScopePath: "src/order-processor/",
        queue: "OrdersQueue",
      }),
    ];
    const findings = checkMessageBus(summaries);
    expect(
      findings.filter(
        (f) =>
          f.kind === "messageBusConsumerOrphan" ||
          f.kind === "messageBusUnused",
      ),
    ).toHaveLength(0);
  });

  it("orphans a consumer whose bus disagrees with the producer's", () => {
    const summaries = [
      queueProvider("OrdersQueue"),
      producerSummary({
        name: "OrderPublisher",
        filePath: "src/api/index.ts",
        channel: "default#order.placed",
      }),
      consumerSummary({
        name: "OrderProcessor.FromOrders",
        channel: "staging#order.placed",
        codeScopePath: "src/order-processor/",
        queue: "OrdersQueue",
      }),
    ];
    const findings = checkMessageBus(summaries);
    const orphan = findings.find((f) => f.kind === "messageBusConsumerOrphan");
    expect(orphan?.description).toContain("staging#order.placed");
  });

  it("keeps pairing a queue-id channel that carries no subject", () => {
    const summaries = [
      queueProvider("OrdersQueue"),
      producerSummary({
        name: "OrderPublisher",
        filePath: "src/api/index.ts",
        channel: "OrdersQueue",
      }),
      consumerSummary({
        name: "OrderProcessor.FromOrders",
        channel: "OrdersQueue",
        codeScopePath: "src/order-processor/",
      }),
    ];
    const findings = checkMessageBus(summaries);
    expect(
      findings.filter(
        (f) =>
          f.kind === "messageBusConsumerOrphan" ||
          f.kind === "messageBusUnused" ||
          f.kind === "messageBusProducerOrphan",
      ),
    ).toHaveLength(0);
  });

  it("pairs a subject that contains the bus separator without splitting it twice", () => {
    const summaries = [
      queueProvider("OrdersQueue"),
      producerSummary({
        name: "OrderPublisher",
        filePath: "src/api/index.ts",
        channel: "AppBus#order#placed",
      }),
      consumerSummary({
        name: "OrderProcessor.FromOrders",
        channel: "AppBus#order#placed",
        codeScopePath: "src/order-processor/",
        queue: "OrdersQueue",
      }),
      consumerSummary({
        name: "PrefixProcessor.FromPrefix",
        channel: "AppBus#order",
        codeScopePath: "src/prefix-processor/",
        queue: "PrefixQueue",
      }),
    ];
    const findings = checkMessageBus(summaries);
    const orphans = findings.filter(
      (f) => f.kind === "messageBusConsumerOrphan",
    );
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.description).toContain('AppBus#order"');
  });

  it("still reports a queue no consumer drains as unused", () => {
    const summaries = [
      queueProvider("OrdersQueue"),
      consumerSummary({
        name: "OtherProcessor.FromOther",
        channel: "other.subject",
        codeScopePath: "src/other/",
        queue: "OtherQueue",
      }),
    ];
    const findings = checkMessageBus(summaries);
    expect(
      findings.filter(
        (f) =>
          f.kind === "messageBusUnused" &&
          f.description.includes("OrdersQueue"),
      ),
    ).toHaveLength(1);
  });
});

describe("sends whose queue the code names at runtime", () => {
  // The recognizer records such a send with a null channel. There is
  // no name to pair on, so the checker must neither call the send an
  // orphan nor let it stand in for a producer on some named channel.

  it("does not orphan a send with no channel", () => {
    const summaries = [
      queueProvider("OrdersQueue"),
      producerSummary({
        name: "OrderPublisher",
        filePath: "src/api/index.ts",
        channel: null,
      }),
    ];
    const findings = checkMessageBus(summaries);
    expect(
      findings.filter((f) => f.kind === "messageBusProducerOrphan"),
    ).toHaveLength(0);
  });

  // This held before the fix as well (an empty subject matched no named
  // one). It pins that the fix stays narrow: an unnamed send must not
  // widen into a producer for every declared queue.
  it("counts unnamed sends into the unused caveat only on the queue's own technology", () => {
    const summaries = [
      queueProvider("OrdersQueue"),
      producerSummary({
        name: "EventPublisher",
        filePath: "src/events/index.ts",
        channel: null,
        messageBus: "eventbridge",
      }),
    ];
    const findings = checkMessageBus(summaries);
    const unused = findings.find((f) => f.kind === "messageBusUnused");
    expect(unused?.description).not.toContain("name the queue at runtime");
  });

  it("does not count a send with no channel as producing to a declared queue", () => {
    const summaries = [
      queueProvider("OrdersQueue"),
      producerSummary({
        name: "OrderPublisher",
        filePath: "src/api/index.ts",
        channel: null,
      }),
    ];
    const findings = checkMessageBus(summaries);
    expect(
      findings.filter(
        (f) =>
          f.kind === "messageBusUnused" &&
          f.description.includes("OrdersQueue"),
      ),
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Integration with checkAll
// ---------------------------------------------------------------------------

/** A code handler bound to a channel: the side that answers. */
function handlerSummary(name: string, channel: string): BehavioralSummary {
  return {
    kind: "handler",
    location: {
      file: "src/orders/placed.ts",
      range: { start: 0, end: 0 },
      exportName: "handler",
    },
    identity: {
      name,
      exportPath: null,
      boundaryBinding: {
        transport: "sqs",
        semantics: { name: "message-bus", messageBus: "sqs", channel },
        recognition: "@suss/framework-aws-lambda",
      },
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

describe("checkAll, message-bus pairing integration", () => {
  it("surfaces which handler answers a declared subscriber", () => {
    const handler = handlerSummary(
      "OrderPlacedFunction.handler",
      "order.placed",
    );
    const subscriber = consumerSummary({
      name: "OrderPlacedFunction.QueueEvent",
      channel: "default#order.placed",
      codeScopePath: "src/orders/",
    });

    const result = checkAll([handler, subscriber]);

    expect(result.pairs).toEqual([
      {
        key: "bus:sqs order.placed",
        provider: "OrderPlacedFunction.handler",
        consumer: "OrderPlacedFunction.QueueEvent",
      },
    ]);
  });

  it("does not run the REST per-pair checks against a message-bus pair", () => {
    const handler = handlerSummary(
      "OrderPlacedFunction.handler",
      "order.placed",
    );
    const subscriber = consumerSummary({
      name: "OrderPlacedFunction.QueueEvent",
      channel: "default#order.placed",
      codeScopePath: "src/orders/",
    });

    const result = checkAll([handler, subscriber]);
    const restKinds = result.findings.filter(
      (f) => !f.kind.startsWith("messageBus"),
    );
    expect(restKinds).toEqual([]);
  });

  it("leaves every judgement about an unpaired channel to checkMessageBus", () => {
    // A declared queue nobody sends to or drains. `messageBusUnused`
    // says so, with a severity. The unmatched list must not say it a
    // second time in weaker words.
    const queue = consumerSummary({
      name: "OrdersQueue",
      channel: "OrdersQueue",
      codeScopePath: "src/orders/",
    });

    const result = checkAll([queue]);

    expect(result.unmatched.providers).toEqual([]);
    expect(result.unmatched.consumers).toEqual([]);
    expect(result.unmatched.unpairable).toEqual([]);
    expect(result.findings.map((f) => f.kind)).toContain(
      "messageBusConsumerOrphan",
    );
  });
});
