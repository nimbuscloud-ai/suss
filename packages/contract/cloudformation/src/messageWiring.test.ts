import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readMessageBusMetadata } from "@suss/behavioral-ir";

import {
  cloudFormationFileToSummaries,
  cloudFormationToSummaries,
} from "./index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

function wires(summaries: BehavioralSummary[]): BehavioralSummary[] {
  return summaries.filter(
    (s) => readMessageBusMetadata(s)?.wiring !== undefined,
  );
}

/** Each wire as `name: wiring -> bus channel (source)`. */
function described(summaries: BehavioralSummary[]): string[] {
  return wires(summaries).map((s) => {
    const send = s.transitions[0]?.effects[0];
    const wiring = readMessageBusMetadata(s)?.wiring;
    if (
      send?.type !== "interaction" ||
      send.interaction.class !== "message-send" ||
      send.binding.semantics.name !== "message-bus"
    ) {
      return `${s.identity.name}: ${wiring} -> nothing`;
    }
    const source =
      send.interaction.routingKey === undefined
        ? ""
        : ` (${send.interaction.routingKey})`;
    return `${s.identity.name}: ${wiring} -> ${send.binding.semantics.messageBus} ${send.binding.semantics.channel}${source}`;
  });
}

const queue = { Type: "AWS::SQS::Queue", Properties: {} };
const topic = { Type: "AWS::SNS::Topic", Properties: {} };

describe("deliveries a template declares", () => {
  it("sends what a queue gives up on to the queue its RedrivePolicy points at", () => {
    const out = cloudFormationToSummaries({
      Resources: {
        OrdersDlq: queue,
        Orders: {
          Type: "AWS::SQS::Queue",
          Properties: {
            RedrivePolicy: {
              deadLetterTargetArn: { "Fn::GetAtt": ["OrdersDlq", "Arn"] },
              maxReceiveCount: 3,
            },
          },
        },
        External: {
          Type: "AWS::SQS::Queue",
          Properties: { RedrivePolicy: { deadLetterTargetArn: "arn:x" } },
        },
      },
    });
    expect(described(out)).toEqual([
      "Orders.RedrivePolicy: redrive -> aws_sqs OrdersDlq",
    ]);
    const wire = wires(out)[0] as BehavioralSummary;
    expect(wire.kind).toBe("library");
    expect(wire.identity.boundaryBinding).toBeNull();
  });

  it("takes a topic's messages off it and puts them on an sqs subscriber's queue", () => {
    const out = cloudFormationToSummaries({
      Resources: {
        Events: topic,
        Inbox: queue,
        InboxDlq: queue,
        ToInbox: {
          Type: "AWS::SNS::Subscription",
          Properties: {
            TopicArn: { Ref: "Events" },
            Protocol: "sqs",
            Endpoint: { "Fn::GetAtt": ["Inbox", "Arn"] },
            RedrivePolicy: {
              deadLetterTargetArn: { "Fn::GetAtt": ["InboxDlq", "Arn"] },
            },
          },
        },
        ToEmail: {
          Type: "AWS::SNS::Subscription",
          Properties: {
            TopicArn: { Ref: "Events" },
            Protocol: "email",
            Endpoint: "a@b.c",
          },
        },
        Loose: {
          Type: "AWS::SNS::Subscription",
          Properties: { Protocol: "sqs", TopicArn: { "Fn::ImportValue": "x" } },
        },
      },
    });
    expect(described(out)).toEqual([
      "ToInbox: subscription -> aws_sqs Inbox",
      "ToInbox.RedrivePolicy: deadLetter -> aws_sqs InboxDlq",
    ]);
    const subscription = wires(out)[0] as BehavioralSummary;
    expect(subscription.kind).toBe("consumer");
    expect(subscription.identity.boundaryBinding?.semantics).toMatchObject({
      messageBus: "aws.sns",
      channel: "Events",
    });
  });

  it("reads an sqs subscription written inline on its topic", () => {
    const out = cloudFormationToSummaries({
      Resources: {
        Inbox: queue,
        Events: {
          Type: "AWS::SNS::Topic",
          Properties: {
            Subscription: [
              { Protocol: "sqs", Endpoint: { "Fn::GetAtt": ["Inbox", "Arn"] } },
              { Protocol: "sqs", Endpoint: { Ref: "Missing" } },
              "not an entry",
            ],
          },
        },
      },
    });
    expect(described(out)).toEqual([
      "Events.Subscription0: subscription -> aws_sqs Inbox",
    ]);
  });

  it("sends a function's failed events to its dead-letter queue and its results to its destinations", () => {
    const out = cloudFormationToSummaries({
      Resources: {
        FnDlq: queue,
        Failures: queue,
        Successes: topic,
        Bus: { Type: "AWS::Events::EventBus", Properties: {} },
        Worker: {
          Type: "AWS::Serverless::Function",
          Properties: {
            CodeUri: "src/worker/",
            DeadLetterQueue: {
              Type: "SQS",
              TargetArn: { "Fn::GetAtt": ["FnDlq", "Arn"] },
            },
            EventInvokeConfig: {
              DestinationConfig: {
                OnSuccess: { Type: "SNS", Destination: { Ref: "Successes" } },
                OnFailure: {
                  Type: "SQS",
                  Destination: { "Fn::GetAtt": ["Failures", "Arn"] },
                },
              },
            },
          },
        },
        Plain: {
          Type: "AWS::Lambda::Function",
          Properties: {},
        },
        PlainInvokeConfig: {
          Type: "AWS::Lambda::EventInvokeConfig",
          Properties: {
            FunctionName: { Ref: "Plain" },
            DestinationConfig: {
              OnFailure: { Destination: { "Fn::GetAtt": ["Bus", "Arn"] } },
              OnSuccess: { Destination: "arn:aws:lambda:x" },
            },
          },
        },
      },
    });
    expect(described(out)).toEqual([
      "Worker.DeadLetterQueue: deadLetter -> aws_sqs FnDlq",
      "Worker.OnSuccess: destination -> aws.sns Successes",
      "Worker.OnFailure: destination -> aws_sqs Failures",
      "Plain.OnFailure: destination -> eventbridge Bus#Lambda Function Invocation Result - Failure (lambda)",
    ]);
  });

  it("sends a batch a stream mapping could not process to its OnFailure queue", () => {
    const out = cloudFormationToSummaries({
      Resources: {
        Failed: queue,
        Mapping: {
          Type: "AWS::Lambda::EventSourceMapping",
          Properties: {
            EventSourceArn: "arn:aws:kinesis:us-east-1:1:stream/s",
            FunctionName: { Ref: "Fn" },
            DestinationConfig: {
              OnFailure: { Destination: { "Fn::GetAtt": ["Failed", "Arn"] } },
            },
          },
        },
        Fn: {
          Type: "AWS::Serverless::Function",
          Properties: {
            CodeUri: "src/fn/",
            Events: {
              Stream: {
                Type: "Kinesis",
                Properties: {
                  DestinationConfig: {
                    OnFailure: {
                      Type: "SQS",
                      Destination: { "Fn::GetAtt": ["Failed", "Arn"] },
                    },
                  },
                },
              },
              Bare: "not an event",
            },
          },
        },
      },
    });
    expect(described(out)).toEqual([
      "Mapping.OnFailure: deadLetter -> aws_sqs Failed",
      "Fn.Stream.OnFailure: deadLetter -> aws_sqs Failed",
    ]);
  });

  it("gives a bucket's queue and topic notifications a wire from the bucket", () => {
    const out = cloudFormationToSummaries({
      Resources: {
        Inbox: queue,
        Alerts: topic,
        Uploads: {
          Type: "AWS::S3::Bucket",
          Properties: {
            NotificationConfiguration: {
              QueueConfigurations: [
                {
                  Event: "s3:ObjectCreated:*",
                  Queue: { "Fn::GetAtt": ["Inbox", "Arn"] },
                },
                null,
              ],
              TopicConfigurations: [{ Topic: { Ref: "Alerts" } }],
            },
          },
        },
        Quiet: {
          Type: "AWS::S3::Bucket",
          Properties: { NotificationConfiguration: "none" },
        },
      },
    });
    expect(described(out)).toEqual([
      "Uploads.QueueConfiguration0: notification -> aws_sqs Inbox",
      "Uploads.TopicConfiguration0: notification -> aws.sns Alerts",
    ]);
  });
});

describe("pipes, schedules and alarms", () => {
  it("takes a pipe's source queue and delivers to its target, or to a bus with the detail-type it sets", () => {
    const out = cloudFormationToSummaries({
      Resources: {
        Source: queue,
        Target: queue,
        Dlq: queue,
        Bus: { Type: "AWS::Events::EventBus", Properties: {} },
        QueueToQueue: {
          Type: "AWS::Pipes::Pipe",
          Properties: {
            Source: { "Fn::GetAtt": ["Source", "Arn"] },
            Target: { "Fn::GetAtt": ["Target", "Arn"] },
          },
        },
        StreamToBus: {
          Type: "AWS::Pipes::Pipe",
          Properties: {
            Source: { "Fn::GetAtt": ["Table", "StreamArn"] },
            SourceParameters: {
              DynamoDBStreamParameters: {
                DeadLetterConfig: { Arn: { "Fn::GetAtt": ["Dlq", "Arn"] } },
              },
            },
            Target: { "Fn::GetAtt": ["Bus", "Arn"] },
            TargetParameters: {
              EventBridgeEventBusParameters: {
                DetailType: "OrderChanged",
                Source: "orders.pipe",
              },
            },
          },
        },
        StreamToMachine: {
          Type: "AWS::Pipes::Pipe",
          Properties: { Source: "arn:x", Target: { Ref: "Machine" } },
        },
      },
    });
    expect(described(out)).toEqual([
      "QueueToQueue: pipe -> aws_sqs Target",
      "StreamToBus: pipe -> eventbridge Bus#OrderChanged (orders.pipe)",
      "StreamToBus.DeadLetterConfig: deadLetter -> aws_sqs Dlq",
    ]);
    const pipe = wires(out)[0] as BehavioralSummary;
    expect(pipe.kind).toBe("consumer");
    expect(pipe.identity.boundaryBinding?.semantics).toMatchObject({
      messageBus: "aws_sqs",
      channel: "Source",
    });
  });

  it("sends a schedule's payload to its target and what it cannot deliver to its dead-letter queue", () => {
    const out = cloudFormationToSummaries({
      Resources: {
        Jobs: queue,
        Dlq: queue,
        Nightly: {
          Type: "AWS::Scheduler::Schedule",
          Properties: {
            Target: {
              Arn: { "Fn::GetAtt": ["Jobs", "Arn"] },
              DeadLetterConfig: { Arn: { "Fn::GetAtt": ["Dlq", "Arn"] } },
            },
          },
        },
        Elsewhere: {
          Type: "AWS::Scheduler::Schedule",
          Properties: { Target: { Arn: "arn:aws:lambda:x" } },
        },
        Fn: {
          Type: "AWS::Serverless::Function",
          Properties: {
            CodeUri: "src/",
            Events: {
              Hourly: {
                Type: "ScheduleV2",
                Properties: {
                  ScheduleExpression: "rate(1 hour)",
                  DeadLetterConfig: { Arn: { "Fn::GetAtt": ["Dlq", "Arn"] } },
                },
              },
            },
          },
        },
      },
    });
    expect(described(out)).toEqual([
      "Nightly: schedule -> aws_sqs Jobs",
      "Nightly.DeadLetterConfig: deadLetter -> aws_sqs Dlq",
      "Fn.Hourly.DeadLetterConfig: deadLetter -> aws_sqs Dlq",
    ]);
  });

  it("publishes to each topic in an alarm's actions once", () => {
    const out = cloudFormationToSummaries({
      Resources: {
        Alerts: topic,
        Errors: {
          Type: "AWS::CloudWatch::Alarm",
          Properties: {
            AlarmActions: [{ Ref: "Alerts" }, "arn:aws:sns:x:1:other"],
            OKActions: [{ Ref: "Alerts" }],
          },
        },
      },
    });
    expect(described(out)).toEqual(["Errors.Alerts: alarm -> aws.sns Alerts"]);
  });
});

describe("where a template summary points", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("puts each summary on the line its resource is written on", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-cfn-lines-"));
    dirs.push(dir);
    const file = path.join(dir, "template.yaml");
    fs.writeFileSync(
      file,
      [
        "Resources:",
        "  OrdersDlq:",
        "    Type: AWS::SQS::Queue",
        "  Orders:",
        "    Type: AWS::SQS::Queue",
        "    Properties:",
        "      RedrivePolicy:",
        "        deadLetterTargetArn: !GetAtt OrdersDlq.Arn",
        "  Table:",
        "    Type: AWS::DynamoDB::Table",
        "    Properties:",
        "      KeySchema: [{ AttributeName: id, KeyType: HASH }]",
        "  Worker:",
        "    Type: AWS::Serverless::Function",
        "    Properties:",
        "      CodeUri: src/",
        "      Events:",
        "        FromOrders:",
        "          Type: SQS",
        "          Properties: { Queue: !GetAtt Orders.Arn }",
      ].join("\n"),
    );

    const out = cloudFormationFileToSummaries(file, { projectRoot: dir });
    const lineOf = (name: string): number | undefined =>
      out.find((s) => s.identity.name === name)?.location.range.start;

    expect(lineOf("OrdersDlq")).toBe(2);
    expect(lineOf("Orders")).toBe(4);
    expect(lineOf("Orders.RedrivePolicy")).toBe(4);
    expect(lineOf("Table")).toBe(9);
    expect(lineOf("Worker.FromOrders")).toBe(13);
    expect(lineOf("Worker")).toBe(13);
  });
});
