import { describe, expect, it } from "vitest";

import {
  readMessageBusMetadata,
  readRuntimeContractMetadata,
} from "@suss/behavioral-ir";

import { cloudFormationToSummaries } from "./index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const raise = (msg: string): never => {
  throw new Error(msg);
};

function pickProviders(summaries: BehavioralSummary[]): BehavioralSummary[] {
  return summaries.filter(
    (s) =>
      s.kind === "library" &&
      s.identity.boundaryBinding?.semantics.name === "message-bus",
  );
}

function pickConsumers(summaries: BehavioralSummary[]): BehavioralSummary[] {
  return summaries.filter(
    (s) =>
      s.kind === "consumer" &&
      s.identity.boundaryBinding?.semantics.name === "message-bus",
  );
}

function channelsOf(summaries: BehavioralSummary[]): (string | null)[] {
  return summaries.map((s) => {
    const semantics = s.identity.boundaryBinding?.semantics;
    return semantics?.name === "message-bus" ? semantics.channel : null;
  });
}

describe("buildMessageBusSummaries", () => {
  it("emits one provider summary per AWS::SQS::Queue", () => {
    const out = cloudFormationToSummaries({
      Resources: {
        OrdersQueue: { Type: "AWS::SQS::Queue", Properties: {} },
        DeadLetterQueue: { Type: "AWS::SQS::Queue", Properties: {} },
      },
    });
    const providers = pickProviders(out);
    expect(providers).toHaveLength(2);
    expect(providers.map((p) => p.identity.name).sort()).toEqual([
      "DeadLetterQueue",
      "OrdersQueue",
    ]);
  });

  it("captures FifoQueue + QueueName in metadata", () => {
    const out = cloudFormationToSummaries({
      Resources: {
        OrdersQueue: {
          Type: "AWS::SQS::Queue",
          Properties: {
            FifoQueue: true,
            QueueName: "orders.fifo",
          },
        },
      },
    });
    const provider = pickProviders(out)[0] ?? raise("no provider");
    expect(provider.metadata?.messageBus).toMatchObject({
      fifoQueue: true,
      physicalName: "orders.fifo",
    });
  });

  it("emits a consumer summary per Lambda Events:SQS event source (SAM)", () => {
    const out = cloudFormationToSummaries({
      Resources: {
        OrdersQueue: { Type: "AWS::SQS::Queue", Properties: {} },
        OrderProcessor: {
          Type: "AWS::Serverless::Function",
          Properties: {
            CodeUri: "src/order-processor/",
            Events: {
              FromOrders: {
                Type: "SQS",
                Properties: { Queue: { "Fn::GetAtt": ["OrdersQueue", "Arn"] } },
              },
            },
          },
        },
      },
    });
    const consumers = pickConsumers(out);
    expect(consumers).toHaveLength(1);
    const consumer = consumers[0] ?? raise("no consumer");
    expect(consumer.identity.name).toBe("OrderProcessor.FromOrders");
    expect(consumer.identity.boundaryBinding?.semantics).toMatchObject({
      name: "message-bus",
      messageBus: "sqs",
      channel: "OrdersQueue",
    });
    // The Lambda this subscription belongs to, so pairing keeps it
    // away from another Lambda's handler on the same subject.
    expect(consumer.identity.deployableUnit).toEqual({
      deploymentTarget: "lambda",
      instanceName: "OrderProcessor",
    });
  });

  it("threads Lambda CodeUri into consumer's metadata.codeScope", () => {
    const out = cloudFormationToSummaries({
      Resources: {
        OrdersQueue: { Type: "AWS::SQS::Queue", Properties: {} },
        OrderProcessor: {
          Type: "AWS::Serverless::Function",
          Properties: {
            CodeUri: "src/order-processor/",
            Events: {
              FromOrders: {
                Type: "SQS",
                Properties: { Queue: { Ref: "OrdersQueue" } },
              },
            },
          },
        },
      },
    });
    const consumer = pickConsumers(out)[0] ?? raise("no consumer");
    expect(consumer.metadata?.codeScope).toEqual({
      kind: "codeUri",
      path: "src/order-processor",
    });
  });

  it("emits a consumer summary for AWS::Lambda::EventSourceMapping (raw CFN)", () => {
    const out = cloudFormationToSummaries({
      Resources: {
        OrdersQueue: { Type: "AWS::SQS::Queue", Properties: {} },
        OrderProcessor: {
          Type: "AWS::Serverless::Function",
          Properties: { CodeUri: "src/order-processor/" },
        },
        OrderEventMapping: {
          Type: "AWS::Lambda::EventSourceMapping",
          Properties: {
            EventSourceArn: { "Fn::GetAtt": ["OrdersQueue", "Arn"] },
            FunctionName: { Ref: "OrderProcessor" },
          },
        },
      },
    });
    const consumers = pickConsumers(out);
    expect(consumers).toHaveLength(1);
    const consumer = consumers[0] ?? raise("no consumer");
    expect(consumer.identity.name).toBe("OrderProcessor.EventSourceMapping");
  });

  it("resolves an EventSourceMapping FunctionName given as Fn::GetAtt", () => {
    const out = cloudFormationToSummaries({
      Resources: {
        OrdersQueue: { Type: "AWS::SQS::Queue", Properties: {} },
        OrderProcessor: {
          Type: "AWS::Serverless::Function",
          Properties: { CodeUri: "src/order-processor/" },
        },
        OrderEventMapping: {
          Type: "AWS::Lambda::EventSourceMapping",
          Properties: {
            EventSourceArn: { "Fn::GetAtt": ["OrdersQueue", "Arn"] },
            FunctionName: { "Fn::GetAtt": ["OrderProcessor", "Arn"] },
          },
        },
      },
    });
    const consumers = pickConsumers(out);
    expect(consumers).toHaveLength(1);
    const consumer = consumers[0] ?? raise("no consumer");
    expect(consumer.identity.name).toBe("OrderProcessor.EventSourceMapping");
    expect(channelsOf(consumers)).toEqual(["OrdersQueue"]);
  });

  it("resolves an EventSourceMapping FunctionName given as a dotted Fn::GetAtt string", () => {
    const out = cloudFormationToSummaries({
      Resources: {
        OrdersQueue: { Type: "AWS::SQS::Queue", Properties: {} },
        OrderProcessor: {
          Type: "AWS::Serverless::Function",
          Properties: { CodeUri: "src/order-processor/" },
        },
        OrderEventMapping: {
          Type: "AWS::Lambda::EventSourceMapping",
          Properties: {
            EventSourceArn: { "Fn::GetAtt": ["OrdersQueue", "Arn"] },
            FunctionName: { "Fn::GetAtt": "OrderProcessor.Arn" },
          },
        },
      },
    });
    const consumers = pickConsumers(out);
    expect(consumers).toHaveLength(1);
    expect(channelsOf(consumers)).toEqual(["OrdersQueue"]);
  });

  it("resolves a plain SQS ARN string to the queue's logical id segment", () => {
    const out = cloudFormationToSummaries({
      Resources: {
        OrderProcessor: {
          Type: "AWS::Serverless::Function",
          Properties: {
            CodeUri: "src/order-processor/",
            Events: {
              FromOrders: {
                Type: "SQS",
                Properties: {
                  Queue:
                    "arn:aws:sqs:us-east-1:123456789012:external-orders-queue",
                },
              },
            },
          },
        },
      },
    });
    const consumer = pickConsumers(out)[0] ?? raise("no consumer");
    expect(consumer.identity.boundaryBinding?.semantics).toMatchObject({
      channel: "external-orders-queue",
    });
  });

  it("ignores non-SQS event sources", () => {
    const out = cloudFormationToSummaries({
      Resources: {
        ApiHandler: {
          Type: "AWS::Serverless::Function",
          Properties: {
            CodeUri: "src/api/",
            Events: {
              GetUsers: {
                Type: "Api",
                Properties: { Path: "/users", Method: "GET" },
              },
            },
          },
        },
      },
    });
    expect(pickConsumers(out)).toEqual([]);
  });

  it("ignores Lambdas with no Events block", () => {
    const out = cloudFormationToSummaries({
      Resources: {
        StandaloneFn: {
          Type: "AWS::Serverless::Function",
          Properties: { CodeUri: "src/standalone/" },
        },
      },
    });
    expect(pickConsumers(out)).toEqual([]);
  });

  it("captures envVarTargets on Lambda runtime-config metadata for !Ref env vars", () => {
    const out = cloudFormationToSummaries({
      Resources: {
        OrdersQueue: { Type: "AWS::SQS::Queue", Properties: {} },
        OrderProducer: {
          Type: "AWS::Serverless::Function",
          Properties: {
            CodeUri: "src/order-producer/",
            Environment: {
              Variables: {
                ORDERS_QUEUE_URL: { Ref: "OrdersQueue" },
                STATIC_CONFIG: "literal-value",
                ORDERS_ARN: { "Fn::GetAtt": ["OrdersQueue", "Arn"] },
              },
            },
          },
        },
      },
    });
    const runtime =
      out.find(
        (s) =>
          s.identity.boundaryBinding?.semantics.name === "runtime-config" &&
          s.identity.name === "OrderProducer",
      ) ?? raise("no runtime");
    const targets = readRuntimeContractMetadata(runtime)?.envVarTargets;
    expect(targets).toMatchObject({
      ORDERS_QUEUE_URL: { kind: "ref", logicalId: "OrdersQueue" },
      ORDERS_ARN: { kind: "ref", logicalId: "OrdersQueue" },
    });
    // STATIC_CONFIG is a string literal, no entry expected.
    expect(targets).not.toHaveProperty("STATIC_CONFIG");
  });

  it("skips event sources whose Queue ref can't be resolved", () => {
    const out = cloudFormationToSummaries({
      Resources: {
        OrderProcessor: {
          Type: "AWS::Serverless::Function",
          Properties: {
            CodeUri: "src/order-processor/",
            Events: {
              FromOrders: {
                Type: "SQS",
                Properties: { Queue: null },
              },
            },
          },
        },
      },
    });
    expect(pickConsumers(out)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// EventBridge
// ---------------------------------------------------------------------------

function isEventBridge(summary: BehavioralSummary): boolean {
  const sem = summary.identity.boundaryBinding?.semantics;
  return sem?.name === "message-bus" && sem.messageBus === "eventbridge";
}

function eventBridgeProviders(
  summaries: BehavioralSummary[],
): BehavioralSummary[] {
  return pickProviders(summaries).filter(isEventBridge);
}

function eventBridgeConsumers(
  summaries: BehavioralSummary[],
): BehavioralSummary[] {
  return pickConsumers(summaries).filter(isEventBridge);
}

function resolutionOf(summary: BehavioralSummary): string | undefined {
  return readMessageBusMetadata(summary)?.patternResolution;
}

describe("buildMessageBusSummaries — EventBridge", () => {
  it("emits a provider per (bus, detailType) a raw AWS::Events::Rule routes", () => {
    const out = cloudFormationToSummaries({
      Resources: {
        OrderEventBus: { Type: "AWS::Events::EventBus", Properties: {} },
        OrderConsumer: {
          Type: "AWS::Serverless::Function",
          Properties: { CodeUri: "src/order-consumer/" },
        },
        OrderEventsRule: {
          Type: "AWS::Events::Rule",
          Properties: {
            EventBusName: { Ref: "OrderEventBus" },
            EventPattern: { "detail-type": ["OrderPlaced", "OrderShipped"] },
            Targets: [
              { Arn: { "Fn::GetAtt": ["OrderConsumer", "Arn"] }, Id: "t1" },
            ],
          },
        },
      },
    });
    expect(
      eventBridgeProviders(out)
        .map((p) => p.identity.name)
        .sort(),
    ).toEqual(["OrderEventBus#OrderPlaced", "OrderEventBus#OrderShipped"]);
  });

  it("emits a consumer per (target, detailType) with the shared channel + codeScope", () => {
    const out = cloudFormationToSummaries({
      Resources: {
        OrderEventBus: { Type: "AWS::Events::EventBus", Properties: {} },
        OrderConsumer: {
          Type: "AWS::Serverless::Function",
          Properties: { CodeUri: "src/order-consumer/" },
        },
        OrderEventsRule: {
          Type: "AWS::Events::Rule",
          Properties: {
            EventBusName: { Ref: "OrderEventBus" },
            EventPattern: { "detail-type": ["OrderPlaced"] },
            Targets: [
              { Arn: { "Fn::GetAtt": ["OrderConsumer", "Arn"] }, Id: "t1" },
            ],
          },
        },
      },
    });
    const consumers = eventBridgeConsumers(out);
    expect(consumers).toHaveLength(1);
    const consumer = consumers[0] ?? raise("no consumer");
    expect(consumer.identity.name).toBe("OrderConsumer#OrderPlaced");
    expect(consumer.identity.boundaryBinding?.semantics).toMatchObject({
      name: "message-bus",
      messageBus: "eventbridge",
      channel: "OrderEventBus#OrderPlaced",
    });
    expect(consumer.metadata?.codeScope).toEqual({
      kind: "codeUri",
      path: "src/order-consumer",
    });
    expect(consumer.identity.deployableUnit).toEqual({
      deploymentTarget: "lambda",
      instanceName: "OrderConsumer",
    });
    expect(resolutionOf(consumer)).toBe("exact");
  });

  it('defaults the bus to "default" when EventBusName is omitted', () => {
    const out = cloudFormationToSummaries({
      Resources: {
        DefaultConsumer: {
          Type: "AWS::Serverless::Function",
          Properties: { CodeUri: "src/default-consumer/" },
        },
        DefaultRule: {
          Type: "AWS::Events::Rule",
          Properties: {
            EventPattern: { "detail-type": ["OrderPlaced"] },
            Targets: [
              { Arn: { "Fn::GetAtt": ["DefaultConsumer", "Arn"] }, Id: "t1" },
            ],
          },
        },
      },
    });
    expect(eventBridgeProviders(out).map((p) => p.identity.name)).toEqual([
      "default#OrderPlaced",
    ]);
  });

  it("handles SAM Events Type: EventBridgeRule targeting the owning Lambda", () => {
    const out = cloudFormationToSummaries({
      Resources: {
        OrderEventBus: { Type: "AWS::Events::EventBus", Properties: {} },
        AuditConsumer: {
          Type: "AWS::Serverless::Function",
          Properties: {
            CodeUri: "src/audit-consumer/",
            Events: {
              OnOrderPlaced: {
                Type: "EventBridgeRule",
                Properties: {
                  EventBusName: { Ref: "OrderEventBus" },
                  Pattern: { "detail-type": ["OrderPlaced"] },
                },
              },
            },
          },
        },
      },
    });
    const consumer = eventBridgeConsumers(out)[0] ?? raise("no consumer");
    expect(consumer.identity.name).toBe("AuditConsumer#OrderPlaced");
    expect(consumer.identity.boundaryBinding?.semantics).toMatchObject({
      channel: "OrderEventBus#OrderPlaced",
    });
  });

  it("marks a rule with no detail-type as unresolvable (never silent)", () => {
    const out = cloudFormationToSummaries({
      Resources: {
        OrderEventBus: { Type: "AWS::Events::EventBus", Properties: {} },
        AuditConsumer: {
          Type: "AWS::Serverless::Function",
          Properties: { CodeUri: "src/audit-consumer/" },
        },
        SourceOnlyRule: {
          Type: "AWS::Events::Rule",
          Properties: {
            EventBusName: { Ref: "OrderEventBus" },
            EventPattern: { source: ["orders.service"] },
            Targets: [
              { Arn: { "Fn::GetAtt": ["AuditConsumer", "Arn"] }, Id: "t1" },
            ],
          },
        },
      },
    });
    const consumers = eventBridgeConsumers(out);
    expect(consumers).toHaveLength(1);
    const consumer = consumers[0] ?? raise("no consumer");
    expect(resolutionOf(consumer)).toBe("unresolvable");
    // No provider is emitted for an unresolvable pattern.
    expect(eventBridgeProviders(out)).toEqual([]);
    const reason = readMessageBusMetadata(consumer)?.unresolvableReason;
    expect(reason).toContain("detail-type");
  });

  it("marks a content-filter detail-type as unresolvable", () => {
    const out = cloudFormationToSummaries({
      Resources: {
        OrderEventBus: { Type: "AWS::Events::EventBus", Properties: {} },
        AuditConsumer: {
          Type: "AWS::Serverless::Function",
          Properties: {
            CodeUri: "src/audit-consumer/",
            Events: {
              OnAnyOrderChange: {
                Type: "EventBridgeRule",
                Properties: {
                  EventBusName: { Ref: "OrderEventBus" },
                  Pattern: { "detail-type": [{ prefix: "Order" }] },
                },
              },
            },
          },
        },
      },
    });
    const consumer = eventBridgeConsumers(out)[0] ?? raise("no consumer");
    expect(resolutionOf(consumer)).toBe("unresolvable");
  });

  it("marks a raw AWS::Events::Rule ScheduleExpression as a schedule", () => {
    const out = cloudFormationToSummaries({
      Resources: {
        ReportGenerator: {
          Type: "AWS::Serverless::Function",
          Properties: { CodeUri: "src/report/" },
        },
        ReportSchedule: {
          Type: "AWS::Events::Rule",
          Properties: {
            ScheduleExpression: "rate(1 day)",
            Targets: [
              { Arn: { "Fn::GetAtt": ["ReportGenerator", "Arn"] }, Id: "t1" },
            ],
          },
        },
      },
    });
    const consumer = eventBridgeConsumers(out)[0] ?? raise("no consumer");
    expect(resolutionOf(consumer)).toBe("schedule");
    // A schedule declares no message channel, so no provider.
    expect(eventBridgeProviders(out)).toEqual([]);
  });

  it("marks SAM Events Type: Schedule as a schedule", () => {
    const out = cloudFormationToSummaries({
      Resources: {
        DigestFunction: {
          Type: "AWS::Serverless::Function",
          Properties: {
            CodeUri: "src/digest/",
            Events: {
              DailyDigest: {
                Type: "Schedule",
                Properties: { Schedule: "rate(1 day)" },
              },
            },
          },
        },
      },
    });
    const consumer = eventBridgeConsumers(out)[0] ?? raise("no consumer");
    expect(consumer.identity.name).toBe("DigestFunction.DailyDigest");
    expect(resolutionOf(consumer)).toBe("schedule");
  });

  it("declares the channel but emits no consumer when a rule's only targets are non-Lambda", () => {
    const out = cloudFormationToSummaries({
      Resources: {
        OrderEventBus: { Type: "AWS::Events::EventBus", Properties: {} },
        DeadLetter: { Type: "AWS::SQS::Queue", Properties: {} },
        ToQueueRule: {
          Type: "AWS::Events::Rule",
          Properties: {
            EventBusName: { Ref: "OrderEventBus" },
            EventPattern: { "detail-type": ["OrderPlaced"] },
            Targets: [
              { Arn: { "Fn::GetAtt": ["DeadLetter", "Arn"] }, Id: "t1" },
            ],
          },
        },
      },
    });
    expect(eventBridgeConsumers(out)).toEqual([]);
    expect(channelsOf(eventBridgeProviders(out))).toEqual([
      "OrderEventBus#OrderPlaced",
    ]);
  });

  it("emits no provider for a rule with no targets at all", () => {
    const out = cloudFormationToSummaries({
      Resources: {
        OrderEventBus: { Type: "AWS::Events::EventBus", Properties: {} },
        NoTargetRule: {
          Type: "AWS::Events::Rule",
          Properties: {
            EventBusName: { Ref: "OrderEventBus" },
            EventPattern: { "detail-type": ["OrderPlaced"] },
            Targets: [],
          },
        },
      },
    });
    expect(eventBridgeProviders(out)).toEqual([]);
  });

  it("dedupes provider summaries when two rules route the same channel", () => {
    const out = cloudFormationToSummaries({
      Resources: {
        OrderEventBus: { Type: "AWS::Events::EventBus", Properties: {} },
        ConsumerA: {
          Type: "AWS::Serverless::Function",
          Properties: { CodeUri: "src/a/" },
        },
        ConsumerB: {
          Type: "AWS::Serverless::Function",
          Properties: { CodeUri: "src/b/" },
        },
        RuleA: {
          Type: "AWS::Events::Rule",
          Properties: {
            EventBusName: { Ref: "OrderEventBus" },
            EventPattern: { "detail-type": ["OrderPlaced"] },
            Targets: [
              { Arn: { "Fn::GetAtt": ["ConsumerA", "Arn"] }, Id: "t1" },
            ],
          },
        },
        RuleB: {
          Type: "AWS::Events::Rule",
          Properties: {
            EventBusName: { Ref: "OrderEventBus" },
            EventPattern: { "detail-type": ["OrderPlaced"] },
            Targets: [
              { Arn: { "Fn::GetAtt": ["ConsumerB", "Arn"] }, Id: "t1" },
            ],
          },
        },
      },
    });
    // One provider (deduped by channel), two consumers (one per target).
    expect(eventBridgeProviders(out)).toHaveLength(1);
    expect(eventBridgeConsumers(out)).toHaveLength(2);
  });
});

describe("buildMessageBusSummaries — EventBridge edge shapes", () => {
  const consumerFn = {
    Type: "AWS::Serverless::Function",
    Properties: { CodeUri: "src/consumer/" },
  };

  function ruleTemplate(ruleProps: Record<string, unknown>) {
    return cloudFormationToSummaries({
      Resources: {
        Consumer: consumerFn,
        Rule: {
          Type: "AWS::Events::Rule",
          Properties: {
            Targets: [{ Arn: { "Fn::GetAtt": ["Consumer", "Arn"] }, Id: "t" }],
            ...ruleProps,
          },
        },
      },
    });
  }

  it("resolves an event-bus ARN string to its bus name segment", () => {
    const out = ruleTemplate({
      EventBusName:
        "arn:aws:events:us-east-1:123456789012:event-bus/orders-bus",
      EventPattern: { "detail-type": ["OrderPlaced"] },
    });
    expect(eventBridgeProviders(out)[0]?.identity.name).toBe(
      "orders-bus#OrderPlaced",
    );
  });

  it("uses a literal bus name string as the bus token", () => {
    const out = ruleTemplate({
      EventBusName: "orders-bus",
      EventPattern: { "detail-type": ["OrderPlaced"] },
    });
    expect(eventBridgeProviders(out)[0]?.identity.name).toBe(
      "orders-bus#OrderPlaced",
    );
  });

  it("marks a non-array detail-type as unresolvable", () => {
    const out = ruleTemplate({
      EventPattern: { "detail-type": "OrderPlaced" },
    });
    const unresolvable = out.filter((s) => resolutionOf(s) === "unresolvable");
    expect(unresolvable.length).toBeGreaterThan(0);
  });

  it("marks an empty detail-type array as unresolvable", () => {
    const out = ruleTemplate({
      EventPattern: { "detail-type": [] },
    });
    expect(out.some((s) => resolutionOf(s) === "unresolvable")).toBe(true);
  });

  it("resolves a target Arn given as short-form GetAtt string", () => {
    const out = cloudFormationToSummaries({
      Resources: {
        Consumer: consumerFn,
        Rule: {
          Type: "AWS::Events::Rule",
          Properties: {
            EventPattern: { "detail-type": ["OrderPlaced"] },
            Targets: [{ Arn: { "Fn::GetAtt": "Consumer.Arn" }, Id: "t" }],
          },
        },
      },
    });
    expect(eventBridgeConsumers(out)).toHaveLength(1);
  });

  it("skips targets whose Arn names a resource missing from the template", () => {
    const out = cloudFormationToSummaries({
      Resources: {
        Rule: {
          Type: "AWS::Events::Rule",
          Properties: {
            EventPattern: { "detail-type": ["OrderPlaced"] },
            Targets: [{ Arn: { "Fn::GetAtt": ["Ghost", "Arn"] }, Id: "t" }],
          },
        },
      },
    });
    expect(eventBridgeConsumers(out)).toHaveLength(0);
  });

  it("skips malformed target entries without an Arn", () => {
    const out = cloudFormationToSummaries({
      Resources: {
        Consumer: consumerFn,
        Rule: {
          Type: "AWS::Events::Rule",
          Properties: {
            EventPattern: { "detail-type": ["OrderPlaced"] },
            Targets: [null, { Id: "no-arn" }, "bogus"],
          },
        },
      },
    });
    expect(eventBridgeConsumers(out)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Subject channels on rule-fed SQS consumers
// ---------------------------------------------------------------------------

function sqsConsumerTemplate(rules: Record<string, unknown>) {
  return {
    Resources: {
      OrdersQueue: { Type: "AWS::SQS::Queue", Properties: {} },
      OrderProcessor: {
        Type: "AWS::Serverless::Function",
        Properties: {
          CodeUri: "src/order-processor/",
          Events: {
            FromOrders: {
              Type: "SQS",
              Properties: { Queue: { "Fn::GetAtt": ["OrdersQueue", "Arn"] } },
            },
          },
        },
      },
      ...rules,
    },
  };
}

function singleSubjectRule(detailTypes: string[], eventBusName?: unknown) {
  return {
    Type: "AWS::Events::Rule",
    Properties: {
      ...(eventBusName !== undefined ? { EventBusName: eventBusName } : {}),
      EventPattern: { "detail-type": detailTypes },
      Targets: [
        { Id: "orders", Arn: { "Fn::GetAtt": ["OrdersQueue", "Arn"] } },
      ],
    },
  };
}

describe("buildMessageBusSummaries: subject channels", () => {
  it("names the consumer channel after the one detail-type routed into its queue", () => {
    const out = cloudFormationToSummaries(
      sqsConsumerTemplate({ OrdersRule: singleSubjectRule(["order.placed"]) }),
    );
    const consumer = pickConsumers(out)[0] ?? raise("no consumer");
    expect(consumer.identity.boundaryBinding?.semantics).toMatchObject({
      name: "message-bus",
      messageBus: "sqs",
      channel: "default#order.placed",
    });
    expect(consumer.metadata?.messageBus).toMatchObject({
      queue: "OrdersQueue",
      subject: "order.placed",
      eventBus: "default",
    });
  });

  it("keeps the queue-id channel on the provider even when its consumer takes the subject", () => {
    const out = cloudFormationToSummaries(
      sqsConsumerTemplate({ OrdersRule: singleSubjectRule(["order.placed"]) }),
    );
    const provider = pickProviders(out)[0] ?? raise("no provider");
    expect(provider.identity.boundaryBinding?.semantics).toMatchObject({
      channel: "OrdersQueue",
    });
  });

  it("keeps the queue-id channel when one rule routes several detail-types", () => {
    const out = cloudFormationToSummaries(
      sqsConsumerTemplate({
        OrdersRule: singleSubjectRule(["order.placed", "order.canceled"]),
      }),
    );
    const consumer = pickConsumers(out)[0] ?? raise("no consumer");
    expect(consumer.identity.boundaryBinding?.semantics).toMatchObject({
      channel: "OrdersQueue",
    });
    expect(consumer.metadata?.messageBus).not.toHaveProperty("subject");
  });

  it("keeps the queue-id channel when two rules route different subjects into the queue", () => {
    const out = cloudFormationToSummaries(
      sqsConsumerTemplate({
        PlacedRule: singleSubjectRule(["order.placed"]),
        CanceledRule: singleSubjectRule(["order.canceled"]),
      }),
    );
    const consumer = pickConsumers(out)[0] ?? raise("no consumer");
    expect(consumer.identity.boundaryBinding?.semantics).toMatchObject({
      channel: "OrdersQueue",
    });
  });

  it("takes the subject when two rules route the same detail-type", () => {
    const out = cloudFormationToSummaries(
      sqsConsumerTemplate({
        PlacedRule: singleSubjectRule(["order.placed"]),
        MirrorRule: singleSubjectRule(["order.placed"]),
      }),
    );
    const consumer = pickConsumers(out)[0] ?? raise("no consumer");
    expect(consumer.identity.boundaryBinding?.semantics).toMatchObject({
      channel: "default#order.placed",
    });
  });

  it("ignores rules whose pattern does not reduce to exact detail-types", () => {
    const out = cloudFormationToSummaries(
      sqsConsumerTemplate({
        FilterRule: {
          Type: "AWS::Events::Rule",
          Properties: {
            EventPattern: { "detail-type": [{ prefix: "order." }] },
            Targets: [
              { Id: "orders", Arn: { "Fn::GetAtt": ["OrdersQueue", "Arn"] } },
            ],
          },
        },
      }),
    );
    const consumer = pickConsumers(out)[0] ?? raise("no consumer");
    expect(consumer.identity.boundaryBinding?.semantics).toMatchObject({
      channel: "OrdersQueue",
    });
  });

  it("ignores scheduled rules when collecting queue subjects", () => {
    const out = cloudFormationToSummaries(
      sqsConsumerTemplate({
        Nightly: {
          Type: "AWS::Events::Rule",
          Properties: {
            ScheduleExpression: "rate(1 day)",
            EventPattern: { "detail-type": ["order.placed"] },
            Targets: [
              { Id: "orders", Arn: { "Fn::GetAtt": ["OrdersQueue", "Arn"] } },
            ],
          },
        },
      }),
    );
    const consumer = pickConsumers(out)[0] ?? raise("no consumer");
    expect(consumer.identity.boundaryBinding?.semantics).toMatchObject({
      channel: "OrdersQueue",
    });
  });

  it("names the EventSourceMapping consumer channel after the routed subject", () => {
    const out = cloudFormationToSummaries({
      Resources: {
        OrdersQueue: { Type: "AWS::SQS::Queue", Properties: {} },
        OrderProcessor: {
          Type: "AWS::Lambda::Function",
          Properties: { Code: {} },
        },
        Mapping: {
          Type: "AWS::Lambda::EventSourceMapping",
          Properties: {
            EventSourceArn: { "Fn::GetAtt": ["OrdersQueue", "Arn"] },
            FunctionName: { Ref: "OrderProcessor" },
          },
        },
        OrdersRule: singleSubjectRule(["order.placed"]),
      },
    });
    const consumer = pickConsumers(out)[0] ?? raise("no consumer");
    expect(consumer.identity.boundaryBinding?.semantics).toMatchObject({
      channel: "default#order.placed",
    });
    expect(consumer.metadata?.messageBus).toMatchObject({
      queue: "OrdersQueue",
      subject: "order.placed",
    });
  });

  it("carries the routing bus in the consumer channel so an EventBridge producer pairs", () => {
    const out = cloudFormationToSummaries({
      Resources: {
        AppBus: { Type: "AWS::Events::EventBus", Properties: {} },
        ...sqsConsumerTemplate({
          OrdersRule: singleSubjectRule(["order.placed"], { Ref: "AppBus" }),
        }).Resources,
      },
    });
    const consumer = pickConsumers(out)[0] ?? raise("no consumer");
    expect(consumer.identity.boundaryBinding?.semantics).toMatchObject({
      channel: "AppBus#order.placed",
    });
    expect(consumer.metadata?.messageBus).toMatchObject({
      queue: "OrdersQueue",
      subject: "order.placed",
      eventBus: "AppBus",
    });
  });

  it("keeps the queue-id channel when two buses route the same detail-type into the queue", () => {
    const out = cloudFormationToSummaries({
      Resources: {
        AppBus: { Type: "AWS::Events::EventBus", Properties: {} },
        ...sqsConsumerTemplate({
          AppRule: singleSubjectRule(["order.placed"], { Ref: "AppBus" }),
          DefaultRule: singleSubjectRule(["order.placed"]),
        }).Resources,
      },
    });
    const consumer = pickConsumers(out)[0] ?? raise("no consumer");
    expect(consumer.identity.boundaryBinding?.semantics).toMatchObject({
      channel: "OrdersQueue",
    });
    expect(consumer.metadata?.messageBus).not.toHaveProperty("subject");
  });

  it("resolves a queue target given as a plain SQS ARN", () => {
    const out = cloudFormationToSummaries({
      Resources: {
        ...sqsConsumerTemplate({}).Resources,
        OrdersRule: {
          Type: "AWS::Events::Rule",
          Properties: {
            EventPattern: { "detail-type": ["order.placed"] },
            Targets: [
              {
                Id: "orders",
                Arn: "arn:aws:sqs:us-east-1:111122223333:OrdersQueue",
              },
            ],
          },
        },
      },
    });
    const consumer = pickConsumers(out)[0] ?? raise("no consumer");
    expect(consumer.identity.boundaryBinding?.semantics).toMatchObject({
      channel: "default#order.placed",
    });
  });

  it("declares the routed subject as a provider when the rule's only target is a queue", () => {
    const out = cloudFormationToSummaries(
      sqsConsumerTemplate({ OrdersRule: singleSubjectRule(["order.placed"]) }),
    );
    const channels = channelsOf(pickProviders(out));
    expect(channels).toContain("default#order.placed");
    expect(channels).toContain("OrdersQueue");
  });

  it("does not lend a rule target's dead-letter queue the routed subject", () => {
    const out = cloudFormationToSummaries({
      Resources: {
        OrdersQueue: { Type: "AWS::SQS::Queue", Properties: {} },
        OrdersDlq: { Type: "AWS::SQS::Queue", Properties: {} },
        DlqProcessor: {
          Type: "AWS::Serverless::Function",
          Properties: {
            CodeUri: "src/dlq-processor/",
            Events: {
              FromDlq: {
                Type: "SQS",
                Properties: { Queue: { "Fn::GetAtt": ["OrdersDlq", "Arn"] } },
              },
            },
          },
        },
        OrdersRule: {
          Type: "AWS::Events::Rule",
          Properties: {
            EventPattern: { "detail-type": ["order.placed"] },
            Targets: [
              {
                Id: "orders",
                Arn: { "Fn::GetAtt": ["OrdersQueue", "Arn"] },
                DeadLetterConfig: {
                  Arn: { "Fn::GetAtt": ["OrdersDlq", "Arn"] },
                },
              },
            ],
          },
        },
      },
    });
    const consumer = pickConsumers(out)[0] ?? raise("no consumer");
    expect(consumer.identity.boundaryBinding?.semantics).toMatchObject({
      channel: "OrdersDlq",
    });
    expect(consumer.metadata?.messageBus).not.toHaveProperty("subject");
  });
});

// ---------------------------------------------------------------------------
// SNS
// ---------------------------------------------------------------------------

function isSns(summary: BehavioralSummary): boolean {
  const sem = summary.identity.boundaryBinding?.semantics;
  return sem?.name === "message-bus" && sem.messageBus === "sns";
}

function snsProviders(summaries: BehavioralSummary[]): BehavioralSummary[] {
  return pickProviders(summaries).filter(isSns);
}

function snsConsumers(summaries: BehavioralSummary[]): BehavioralSummary[] {
  return pickConsumers(summaries).filter(isSns);
}

const orderProcessor = {
  Type: "AWS::Serverless::Function",
  Properties: { CodeUri: "src/order-processor/" },
};

describe("buildMessageBusSummaries — SNS", () => {
  it("emits one provider summary per AWS::SNS::Topic", () => {
    const out = cloudFormationToSummaries({
      Resources: {
        OrderEvents: { Type: "AWS::SNS::Topic", Properties: {} },
        Alerts: { Type: "AWS::SNS::Topic", Properties: {} },
      },
    });
    const providers = snsProviders(out);
    expect(providers).toHaveLength(2);
    expect(providers.map((p) => p.identity.name).sort()).toEqual([
      "Alerts",
      "OrderEvents",
    ]);
  });

  it("captures FifoTopic + TopicName in metadata", () => {
    const out = cloudFormationToSummaries({
      Resources: {
        OrderEvents: {
          Type: "AWS::SNS::Topic",
          Properties: { FifoTopic: true, TopicName: "order-events.fifo" },
        },
      },
    });
    const provider = snsProviders(out)[0] ?? raise("no provider");
    expect(provider.metadata?.messageBus).toMatchObject({
      fifoTopic: true,
      physicalName: "order-events.fifo",
    });
  });

  it("emits a consumer for a standalone Protocol lambda Subscription, channelled on the topic", () => {
    const out = cloudFormationToSummaries({
      Resources: {
        OrderEvents: { Type: "AWS::SNS::Topic", Properties: {} },
        OrderProcessor: orderProcessor,
        ToOrderProcessor: {
          Type: "AWS::SNS::Subscription",
          Properties: {
            TopicArn: { Ref: "OrderEvents" },
            Protocol: "lambda",
            Endpoint: { "Fn::GetAtt": ["OrderProcessor", "Arn"] },
          },
        },
      },
    });
    const consumers = snsConsumers(out);
    expect(consumers).toHaveLength(1);
    const consumer = consumers[0] ?? raise("no consumer");
    expect(consumer.identity.name).toBe("OrderProcessor.ToOrderProcessor");
    expect(consumer.identity.boundaryBinding?.semantics).toMatchObject({
      name: "message-bus",
      messageBus: "sns",
      channel: "OrderEvents",
    });
    expect(consumer.identity.deployableUnit).toEqual({
      deploymentTarget: "lambda",
      instanceName: "OrderProcessor",
    });
    expect(consumer.metadata?.codeScope).toEqual({
      kind: "codeUri",
      path: "src/order-processor",
    });
    expect(consumer.metadata?.messageBus).toMatchObject({
      subscription: "ToOrderProcessor",
      patternResolution: "exact",
    });
  });

  it("emits an equivalent consumer for an inline Protocol lambda Subscription on the topic", () => {
    const out = cloudFormationToSummaries({
      Resources: {
        OrderEvents: {
          Type: "AWS::SNS::Topic",
          Properties: {
            Subscription: [
              {
                Protocol: "lambda",
                Endpoint: { "Fn::GetAtt": ["OrderProcessor", "Arn"] },
              },
            ],
          },
        },
        OrderProcessor: orderProcessor,
      },
    });
    const consumers = snsConsumers(out);
    expect(consumers).toHaveLength(1);
    const consumer = consumers[0] ?? raise("no consumer");
    expect(consumer.identity.boundaryBinding?.semantics).toMatchObject({
      name: "message-bus",
      messageBus: "sns",
      channel: "OrderEvents",
    });
    expect(consumer.identity.deployableUnit).toEqual({
      deploymentTarget: "lambda",
      instanceName: "OrderProcessor",
    });
    expect(consumer.metadata?.messageBus).toMatchObject({
      patternResolution: "exact",
    });
  });

  it("subscribes the function for a SAM Events Type: SNS entry", () => {
    const out = cloudFormationToSummaries({
      Resources: {
        OrderEvents: { Type: "AWS::SNS::Topic", Properties: {} },
        OrderProcessor: {
          Type: "AWS::Serverless::Function",
          Properties: {
            CodeUri: "src/order-processor/",
            Events: {
              FromOrderEvents: {
                Type: "SNS",
                Properties: { Topic: { Ref: "OrderEvents" } },
              },
            },
          },
        },
      },
    });
    const consumers = snsConsumers(out);
    expect(consumers).toHaveLength(1);
    const consumer = consumers[0] ?? raise("no consumer");
    expect(consumer.identity.name).toBe("OrderProcessor.FromOrderEvents");
    expect(consumer.identity.boundaryBinding?.semantics).toMatchObject({
      channel: "OrderEvents",
    });
    expect(consumer.metadata?.messageBus).toMatchObject({
      patternResolution: "exact",
    });
  });

  it("marks a Protocol lambda subscription with a FilterPolicy as unresolvable, naming the policy", () => {
    const out = cloudFormationToSummaries({
      Resources: {
        OrderEvents: { Type: "AWS::SNS::Topic", Properties: {} },
        OrderProcessor: orderProcessor,
        ToOrderProcessor: {
          Type: "AWS::SNS::Subscription",
          Properties: {
            TopicArn: { Ref: "OrderEvents" },
            Protocol: "lambda",
            Endpoint: { "Fn::GetAtt": ["OrderProcessor", "Arn"] },
            FilterPolicy: { eventType: ["order.placed"] },
          },
        },
      },
    });
    const consumer = snsConsumers(out)[0] ?? raise("no consumer");
    expect(readMessageBusMetadata(consumer)?.patternResolution).toBe(
      "unresolvable",
    );
    expect(readMessageBusMetadata(consumer)?.unresolvableReason).toContain(
      "FilterPolicy",
    );
  });

  it("skips a subscription protocol that isn't lambda or sqs", () => {
    const out = cloudFormationToSummaries({
      Resources: {
        OrderEvents: { Type: "AWS::SNS::Topic", Properties: {} },
        ToOncall: {
          Type: "AWS::SNS::Subscription",
          Properties: {
            TopicArn: { Ref: "OrderEvents" },
            Protocol: "email",
            Endpoint: "oncall@example.com",
          },
        },
      },
    });
    expect(pickConsumers(out)).toEqual([]);
  });

  it("skips a Protocol lambda subscription whose Endpoint can't be resolved", () => {
    const out = cloudFormationToSummaries({
      Resources: {
        OrderEvents: { Type: "AWS::SNS::Topic", Properties: {} },
        OrderProcessor: orderProcessor,
        ToOrderProcessor: {
          Type: "AWS::SNS::Subscription",
          Properties: {
            TopicArn: { Ref: "OrderEvents" },
            Protocol: "lambda",
            Endpoint: null,
          },
        },
      },
    });
    expect(snsConsumers(out)).toEqual([]);
  });

  it("skips a Protocol lambda subscription whose Endpoint names a resource missing from the template", () => {
    const out = cloudFormationToSummaries({
      Resources: {
        OrderEvents: { Type: "AWS::SNS::Topic", Properties: {} },
        ToGhost: {
          Type: "AWS::SNS::Subscription",
          Properties: {
            TopicArn: { Ref: "OrderEvents" },
            Protocol: "lambda",
            Endpoint: { "Fn::GetAtt": ["Ghost", "Arn"] },
          },
        },
      },
    });
    expect(snsConsumers(out)).toEqual([]);
  });

  describe("Protocol sqs bridges into the queue's own consumer", () => {
    function snsFedQueueTemplate(subscriptionProps: Record<string, unknown>) {
      return {
        Resources: {
          OrderEvents: { Type: "AWS::SNS::Topic", Properties: {} },
          OrdersQueue: { Type: "AWS::SQS::Queue", Properties: {} },
          OrderProcessor: {
            Type: "AWS::Serverless::Function",
            Properties: {
              CodeUri: "src/order-processor/",
              Events: {
                FromOrders: {
                  Type: "SQS",
                  Properties: {
                    Queue: { "Fn::GetAtt": ["OrdersQueue", "Arn"] },
                  },
                },
              },
            },
          },
          ToOrdersQueue: {
            Type: "AWS::SNS::Subscription",
            Properties: {
              TopicArn: { Ref: "OrderEvents" },
              Protocol: "sqs",
              Endpoint: { "Fn::GetAtt": ["OrdersQueue", "Arn"] },
              ...subscriptionProps,
            },
          },
        },
      };
    }

    it("does not emit its own consumer for a Protocol sqs subscription", () => {
      const out = cloudFormationToSummaries(snsFedQueueTemplate({}));
      expect(snsConsumers(out)).toEqual([]);
    });

    it("routes the queue's Lambda consumer onto the topic's channel", () => {
      const out = cloudFormationToSummaries(snsFedQueueTemplate({}));
      const consumer = pickConsumers(out)[0] ?? raise("no consumer");
      expect(consumer.identity.boundaryBinding?.semantics).toMatchObject({
        name: "message-bus",
        messageBus: "sqs",
        channel: "OrderEvents",
      });
      expect(consumer.metadata?.messageBus).toMatchObject({
        queue: "OrdersQueue",
      });
    });

    it("keeps the queue's own channel when the subscription declares a FilterPolicy", () => {
      const out = cloudFormationToSummaries(
        snsFedQueueTemplate({ FilterPolicy: { eventType: ["order.placed"] } }),
      );
      const consumer = pickConsumers(out)[0] ?? raise("no consumer");
      expect(consumer.identity.boundaryBinding?.semantics).toMatchObject({
        channel: "OrdersQueue",
      });
    });

    it("keeps the queue's own channel when two subscriptions feed different topics into it", () => {
      const template = snsFedQueueTemplate({});
      const out = cloudFormationToSummaries({
        Resources: {
          ...template.Resources,
          OtherEvents: { Type: "AWS::SNS::Topic", Properties: {} },
          AlsoToOrdersQueue: {
            Type: "AWS::SNS::Subscription",
            Properties: {
              TopicArn: { Ref: "OtherEvents" },
              Protocol: "sqs",
              Endpoint: { "Fn::GetAtt": ["OrdersQueue", "Arn"] },
            },
          },
        },
      });
      const consumer = pickConsumers(out)[0] ?? raise("no consumer");
      expect(consumer.identity.boundaryBinding?.semantics).toMatchObject({
        channel: "OrdersQueue",
      });
    });

    it("keeps the queue's own channel when a rule and a subscription both route into it", () => {
      const template = snsFedQueueTemplate({});
      const out = cloudFormationToSummaries({
        Resources: {
          ...template.Resources,
          OrdersRule: singleSubjectRule(["order.placed"]),
        },
      });
      const consumer = pickConsumers(out)[0] ?? raise("no consumer");
      expect(consumer.identity.boundaryBinding?.semantics).toMatchObject({
        channel: "OrdersQueue",
      });
    });
  });
});
