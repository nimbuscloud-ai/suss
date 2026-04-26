import { describe, expect, it } from "vitest";

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
      path: "src/order-processor/",
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
