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
