import { describe, expect, it } from "vitest";

import { checkAll } from "../index.js";
import { checkMessageBus } from "./messageBusPairing.js";

import type { BehavioralSummary, Effect } from "@suss/behavioral-ir";
import type { ComparedPair } from "../pairing/comparedPair.js";

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
        transport: "aws_sqs",
        semantics: {
          name: "message-bus",
          messageBus: "aws_sqs",
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
  /** Null is a send whose queue the code only works out at runtime. */
  channel: string | null;
  bodyFields?: string[] | null;
  messageBus?: "aws_sqs" | "eventbridge";
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
      transport: "aws_sqs",
      semantics: {
        name: "message-bus",
        messageBus: opts.messageBus ?? "aws_sqs",
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
      transport: "aws_sqs",
      semantics: {
        name: "message-bus",
        messageBus: "aws_sqs",
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
        transport: "aws_sqs",
        semantics: {
          name: "message-bus",
          messageBus: "aws_sqs",
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
        bodyFields: null, // opaque: `JSON.stringify(event.order)` style
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
  enabled?: boolean;
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
        ...(opts.enabled !== undefined ? { enabled: opts.enabled } : {}),
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

  it("resolves a bus spelled as a kept reference the same as a bare env name", () => {
    // A recognizer that keeps the reference spells the bus
    // `{ORDER_EVENT_BUS_NAME}`, and an older one spells it bare. Both
    // resolve against the same Environment block, so migrating a pack
    // does not orphan its producers.
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
        channel: "{ORDER_EVENT_BUS_NAME}#OrderPlaced",
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
  });

  it("splits an EventBridge channel on the first hash, keeping a detail-type that carries a hash of its own", () => {
    const summaries = [
      eventBridgeProvider("OrderEventBus#Order#Placed"),
      eventBridgeConsumer({
        name: "OrderConsumer#Order#Placed",
        channel: "OrderEventBus#Order#Placed",
        patternResolution: "exact",
      }),
      eventBridgeProducer({
        name: "OrderProducer",
        filePath: "src/order-producer/index.ts",
        channel: "ORDER_EVENT_BUS_NAME#Order#Placed",
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
  });

  it("leaves a hash inside an SQS queue name alone, since only EventBridge splits a channel", () => {
    const summaries = [
      consumerSummary({
        name: "OrdersQueue",
        channel: "Orders#Queue",
        codeScopePath: "src/order-producer/",
      }),
      producerSummary({
        name: "OrderProducer",
        filePath: "src/order-producer/index.ts",
        channel: "ORDERS#QUEUE_URL",
      }),
      runtimeConfigProvider({
        instanceName: "OrderProducer",
        codeScopePath: "src/order-producer/",
        envVarTargets: {
          "ORDERS#QUEUE_URL": { kind: "ref", logicalId: "Orders#Queue" },
        },
      }),
    ];

    const findings = checkMessageBus(summaries);

    expect(
      findings.filter((f) => f.kind === "messageBusProducerOrphan"),
    ).toEqual([]);
  });

  it("flags an orphan producer when no runtime-config provider resolves the env var naming the bus", () => {
    const summaries = [
      eventBridgeProvider("OrderEventBus#OrderPlaced"),
      eventBridgeProducer({
        name: "OrderProducer",
        filePath: "src/order-producer/index.ts",
        channel: "ORDER_EVENT_BUS_NAME#OrderPlaced",
      }),
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

  it("surfaces an unresolvable rule as unsupportedSemantics (info) and reports no consumer orphan for it", () => {
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

describe("disabled subscriptions", () => {
  it("reports a disabled rule as disabled (info), not as a waiting consumer orphan", () => {
    const summaries = [
      eventBridgeProvider("OrderEventBus#OrderCancelled"),
      eventBridgeConsumer({
        name: "IdleConsumer#OrderCancelled",
        channel: "OrderEventBus#OrderCancelled",
        patternResolution: "exact",
        rule: "IdleRule",
        enabled: false,
      }),
    ];
    const findings = checkMessageBus(summaries);
    const disabled = findings.find(
      (f) => f.kind === "messageBusConsumerDisabled",
    );
    expect(disabled).toBeDefined();
    expect(disabled?.severity).toBe("info");
    expect(disabled?.description).toContain("IdleRule");
    expect(
      findings.filter((f) => f.kind === "messageBusConsumerOrphan"),
    ).toEqual([]);
  });

  it("orphans a producer whose only subscriber is disabled, and says the subscription is off", () => {
    const summaries = [
      eventBridgeProvider("OrderEventBus#OrderCancelled"),
      eventBridgeConsumer({
        name: "IdleConsumer#OrderCancelled",
        channel: "OrderEventBus#OrderCancelled",
        patternResolution: "exact",
        rule: "IdleRule",
        enabled: false,
      }),
      eventBridgeProducer({
        name: "OrderProducer",
        filePath: "src/order-producer/index.ts",
        channel: "OrderEventBus#OrderCancelled",
      }),
    ];
    const findings = checkMessageBus(summaries);
    const orphan = findings.find((f) => f.kind === "messageBusProducerOrphan");
    expect(orphan).toBeDefined();
    expect(orphan?.description).toContain("deployed disabled");
  });

  it("does not report a channel routed only by a disabled rule as unused", () => {
    const summaries = [
      eventBridgeProvider("OrderEventBus#OrderCancelled"),
      eventBridgeConsumer({
        name: "IdleConsumer#OrderCancelled",
        channel: "OrderEventBus#OrderCancelled",
        patternResolution: "exact",
        rule: "IdleRule",
        enabled: false,
      }),
    ];
    const findings = checkMessageBus(summaries);
    expect(findings.filter((f) => f.kind === "messageBusUnused")).toEqual([]);
  });

  it("keeps pairing a channel that an enabled rule routes beside a disabled one", () => {
    const summaries = [
      eventBridgeProvider("OrderEventBus#OrderPlaced"),
      eventBridgeConsumer({
        name: "IdleConsumer#OrderPlaced",
        channel: "OrderEventBus#OrderPlaced",
        patternResolution: "exact",
        rule: "IdleRule",
        enabled: false,
      }),
      eventBridgeConsumer({
        name: "OrderConsumer#OrderPlaced",
        channel: "OrderEventBus#OrderPlaced",
        patternResolution: "exact",
        rule: "OrderEventsRule",
      }),
      eventBridgeProducer({
        name: "OrderProducer",
        filePath: "src/order-producer/index.ts",
        channel: "OrderEventBus#OrderPlaced",
      }),
    ];
    const findings = checkMessageBus(summaries);
    expect(
      findings.filter((f) => f.kind === "messageBusProducerOrphan"),
    ).toEqual([]);
    expect(
      findings.filter((f) => f.kind === "messageBusConsumerDisabled"),
    ).toHaveLength(1);
  });
});

function snsConsumer(opts: {
  name: string;
  channel: string;
  patternResolution: "exact" | "unresolvable";
  subscription?: string;
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
        transport: "sns",
        semantics: {
          name: "message-bus",
          messageBus: "aws.sns",
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
        ...(opts.subscription !== undefined
          ? { subscription: opts.subscription }
          : {}),
        ...(opts.unresolvableReason !== undefined
          ? { unresolvableReason: opts.unresolvableReason }
          : {}),
      },
    },
  };
}

describe("sns pairing", () => {
  it("flags a consumer orphan for a topic no producer sends to", () => {
    const summaries = [
      snsConsumer({
        name: "OrderProcessor.ToOrderProcessor",
        channel: "OrderEvents",
        patternResolution: "exact",
      }),
    ];
    const findings = checkMessageBus(summaries);
    const orphan = findings.find((f) => f.kind === "messageBusConsumerOrphan");
    expect(orphan).toBeDefined();
    if (orphan?.boundary.semantics.name === "message-bus") {
      expect(orphan.boundary.semantics.channel).toBe("OrderEvents");
    }
  });

  it("surfaces a FilterPolicy subscription as unsupportedSemantics naming the subscription rather than an EventBridge rule, and reports no consumer orphan for it", () => {
    const summaries = [
      snsConsumer({
        name: "OrderProcessor.ToOrderProcessor",
        channel: "OrderEvents",
        patternResolution: "unresolvable",
        subscription: "ToOrderProcessor",
        unresolvableReason: "subscription declares a FilterPolicy",
      }),
    ];
    const findings = checkMessageBus(summaries);
    const unresolvable = findings.find(
      (f) => f.kind === "unsupportedSemantics",
    );
    expect(unresolvable).toBeDefined();
    expect(unresolvable?.severity).toBe("info");
    expect(unresolvable?.description).toContain("SNS subscription");
    expect(unresolvable?.description).toContain("ToOrderProcessor");
    expect(unresolvable?.description).not.toContain("EventBridge rule");
    expect(
      findings.filter((f) => f.kind === "messageBusConsumerOrphan"),
    ).toEqual([]);
  });
});

function s3Consumer(opts: {
  name: string;
  channel: string;
  patternResolution: "exact" | "unresolvable";
  notification?: string;
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
        transport: "s3",
        semantics: {
          name: "message-bus",
          messageBus: "s3",
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
        ...(opts.notification !== undefined
          ? { notification: opts.notification }
          : {}),
        ...(opts.unresolvableReason !== undefined
          ? { unresolvableReason: opts.unresolvableReason }
          : {}),
      },
    },
  };
}

describe("s3 pairing", () => {
  it("flags a consumer orphan for a bucket no producer sends to", () => {
    const summaries = [
      s3Consumer({
        name: "ImageProcessor.Uploads.LambdaConfiguration0",
        channel: "Uploads",
        patternResolution: "exact",
      }),
    ];
    const findings = checkMessageBus(summaries);
    const orphan = findings.find((f) => f.kind === "messageBusConsumerOrphan");
    expect(orphan).toBeDefined();
    if (orphan?.boundary.semantics.name === "message-bus") {
      expect(orphan.boundary.semantics.channel).toBe("Uploads");
    }
  });

  it("surfaces a Filter notification as unsupportedSemantics naming the notification rather than an EventBridge rule, and reports no consumer orphan for it", () => {
    const summaries = [
      s3Consumer({
        name: "ImageProcessor.Uploads.LambdaConfiguration0",
        channel: "Uploads",
        patternResolution: "unresolvable",
        notification: "Uploads.LambdaConfiguration0",
        unresolvableReason: "notification declares a Filter",
      }),
    ];
    const findings = checkMessageBus(summaries);
    const unresolvable = findings.find(
      (f) => f.kind === "unsupportedSemantics",
    );
    expect(unresolvable).toBeDefined();
    expect(unresolvable?.severity).toBe("info");
    expect(unresolvable?.description).toContain("S3 notification");
    expect(unresolvable?.description).toContain("Uploads.LambdaConfiguration0");
    expect(unresolvable?.description).not.toContain("EventBridge rule");
    expect(
      findings.filter((f) => f.kind === "messageBusConsumerOrphan"),
    ).toEqual([]);
  });

  it("falls back to a default reason when an unresolvable S3 consumer names none of its own", () => {
    const summaries = [
      s3Consumer({
        name: "ImageProcessor.Uploads.LambdaConfiguration0",
        channel: "Uploads",
        patternResolution: "unresolvable",
      }),
    ];
    const findings = checkMessageBus(summaries);
    const unresolvable = findings.find(
      (f) => f.kind === "unsupportedSemantics",
    );
    expect(unresolvable?.description).toContain(
      "the Filter couldn't be reduced to the whole bucket",
    );
  });
});

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
        transport: "aws_sqs",
        semantics: {
          name: "message-bus",
          messageBus: "aws_sqs",
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

  it("does not orphan a producer whose subject a consumer answers, even though no provider declares that subject", () => {
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

describe("sends whose queue the code names at runtime, recorded with a null channel", () => {
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
        transport: "aws_sqs",
        semantics: { name: "message-bus", messageBus: "aws_sqs", channel },
        recognition: "@suss/framework-aws-lambda",
      },
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

describe("what the message-bus pass records as compared", () => {
  it("names the queue and the code that sends to it", () => {
    const summaries = [
      queueProvider("OrdersQueue"),
      producerSummary({
        name: "OrderProducer",
        filePath: "src/order-producer/index.ts",
        channel: "OrdersQueue",
        bodyFields: ["id"],
      }),
    ];
    const compared: ComparedPair[] = [];
    checkMessageBus(summaries, undefined, compared);

    expect(compared).toEqual([
      {
        key: "bus:aws_sqs OrdersQueue",
        provider: "template.yaml::OrdersQueue",
        consumer: "src/order-producer/index.ts::OrderProducer",
      },
    ]);
  });

  it("records a queue a subscriber drains even with nobody sending to it", () => {
    const summaries = [
      queueProvider("OrdersQueue"),
      consumerSummary({
        name: "OrderConsumer",
        channel: "OrdersQueue",
        codeScopePath: "src/order-consumer/",
      }),
    ];
    const compared: ComparedPair[] = [];
    checkMessageBus(summaries, undefined, compared);

    expect(compared).toEqual([
      {
        key: "bus:aws_sqs OrdersQueue",
        provider: "template.yaml::OrdersQueue",
        consumer: "template.yaml::OrderConsumer",
      },
    ]);
  });

  it("records nothing for a send whose queue nothing declares", () => {
    const summaries = [
      producerSummary({
        name: "OrderProducer",
        filePath: "src/order-producer/index.ts",
        channel: "OrdersQueue",
        bodyFields: ["id"],
      }),
    ];
    const compared: ComparedPair[] = [];
    checkMessageBus(summaries, undefined, compared);

    expect(compared).toEqual([]);
  });
});

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
        key: "bus:aws_sqs order.placed",
        provider: "src/orders/placed.ts::OrderPlacedFunction.handler",
        consumer: "template.yaml::OrderPlacedFunction.QueueEvent",
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

describe("what message-bus pairing takes for granted", () => {
  it("compares a channel's subject letter for letter", () => {
    const findings = checkMessageBus([
      queueProvider("OrdersQueue"),
      producerSummary({
        name: "OrderProducer",
        filePath: "src/order-producer/index.ts",
        channel: "ordersqueue",
      }),
    ]);

    expect(findings.map((f) => f.kind).sort()).toEqual([
      "messageBusProducerOrphan",
      "messageBusUnused",
    ]);
  });

  it("lets every producer on a channel account for what any consumer receives", () => {
    const findings = checkMessageBus([
      queueProvider("OrdersQueue"),
      producerSummary({
        name: "OrderProducer",
        filePath: "src/order-producer/index.ts",
        channel: "OrdersQueue",
        bodyFields: ["id"],
      }),
      producerSummary({
        name: "RefundProducer",
        filePath: "src/refund-producer/index.ts",
        channel: "OrdersQueue",
        bodyFields: ["refundId"],
      }),
      consumerSummary({
        name: "OrderConsumer",
        channel: "OrdersQueue",
        codeScopePath: "src/order-consumer/",
      }),
      consumerCodeSummary({
        name: "handler",
        filePath: "src/order-consumer/index.ts",
        bodyFields: ["id", "refundId"],
      }),
    ]);

    expect(
      findings.filter(
        (f) => f.kind === "boundaryFieldUnknown" && f.aspect === "receive",
      ),
    ).toEqual([]);
  });

  it("says nothing about a message arriving more than once", () => {
    const findings = checkMessageBus([
      queueProvider("OrdersQueue"),
      producerSummary({
        name: "OrderProducer",
        filePath: "src/order-producer/index.ts",
        channel: "OrdersQueue",
        bodyFields: ["id"],
      }),
      consumerSummary({
        name: "OrderConsumer",
        channel: "OrdersQueue",
        codeScopePath: "src/order-consumer/",
      }),
      consumerCodeSummary({
        name: "handler",
        filePath: "src/order-consumer/index.ts",
        bodyFields: ["id"],
      }),
    ]);

    expect(findings).toEqual([]);
  });
});
