// Unit tests for the body-shape pairing pass in checkMessageBus.
//
// Wiring-finding paths (orphan / unused) are exercised by the
// CLI's awsSqsIntegration end-to-end test against the real fixture;
// these tests focus on the body-shape branches with hand-built
// summaries so the coverage threshold doesn't drift on us silently.

import { describe, expect, it } from "vitest";

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
  channel: string;
  bodyFields?: string[] | null;
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
        messageBus: "sqs",
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
        channel: "",
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
