// messageBus.ts — emit message-bus provider summaries (one per
// AWS::SQS::Queue) and consumer summaries (one per Lambda whose
// SAM Events block declares an SQS event source).
//
// Provider summaries describe "this queue exists; messages cross
// it." They pair against producer-side `interaction(class:
// "message-send")` effects emitted by `@suss/framework-aws-sqs`.
//
// Consumer summaries describe "this Lambda receives messages from
// queue X." They share the same messageBus boundary identity as the
// queue, so the pairing dispatcher can match producers to consumers
// via shared channel.

import { messageBusBinding } from "@suss/behavioral-ir";

import type { BehavioralSummary } from "@suss/behavioral-ir";

interface CloudFormationResource {
  Type?: string;
  Properties?: Record<string, unknown>;
  Metadata?: Record<string, unknown>;
}

/**
 * Walk the resources for AWS::SQS::Queue + Lambdas with SAM-style
 * `Events: { Type: SQS, Properties: { Queue: !GetAtt X.Arn } }` and
 * emit:
 *
 *   - One library-kind QUEUE PROVIDER summary per AWS::SQS::Queue.
 *     Identity binding: messageBus(channel = CFN logical ID). Carries
 *     a fifoQueue flag in metadata when the queue is FIFO (used by
 *     future ordering checks).
 *
 *   - One consumer-kind LAMBDA CONSUMER summary per Lambda+Event
 *     pair. Identity binding: messageBus(channel = CFN logical ID
 *     of the queue resolved via the event's Queue Ref/GetAtt).
 *     metadata.codeScope mirrors the runtime-config summary's so
 *     the pairing layer can scope code reads to this consumer.
 *
 * Producer effects on the consumer side are NOT emitted here — those
 * are recognized at extraction time by `@suss/framework-aws-sqs`.
 */
export function buildMessageBusSummaries(
  resources: Record<string, CloudFormationResource>,
  sourceFile: string,
): BehavioralSummary[] {
  const summaries: BehavioralSummary[] = [];

  // 1. Provider summaries: one per AWS::SQS::Queue.
  for (const [logicalId, resource] of Object.entries(resources)) {
    if (resource.Type !== "AWS::SQS::Queue") {
      continue;
    }
    summaries.push(buildQueueProviderSummary(logicalId, resource, sourceFile));
  }

  // 2. Consumer summaries: walk Lambdas (AWS::Serverless::Function or
  //    AWS::Lambda::Function with EventSourceMapping) and detect SQS
  //    event sources.
  for (const [logicalId, resource] of Object.entries(resources)) {
    if (resource.Type !== "AWS::Serverless::Function") {
      continue;
    }
    const events = resource.Properties?.Events;
    if (events === null || typeof events !== "object") {
      continue;
    }
    for (const [eventName, eventDef] of Object.entries(
      events as Record<string, unknown>,
    )) {
      if (
        eventDef === null ||
        typeof eventDef !== "object" ||
        (eventDef as { Type?: string }).Type !== "SQS"
      ) {
        continue;
      }
      const queueRef = (eventDef as { Properties?: { Queue?: unknown } })
        .Properties?.Queue;
      const channel = resolveQueueChannel(queueRef);
      if (channel === null) {
        continue;
      }
      summaries.push(
        buildLambdaConsumerSummary({
          lambdaId: logicalId,
          lambdaResource: resource,
          eventName,
          channel,
          sourceFile,
        }),
      );
    }
  }

  // 3. AWS::Lambda::EventSourceMapping (for AWS::Lambda::Function-style
  //    Lambdas; SAM expands SQS Events into one of these but raw CFN
  //    declares it directly). Pairs the EventSourceArn (which Refs the
  //    queue) with the FunctionName (which Refs the Lambda).
  for (const [, resource] of Object.entries(resources)) {
    if (resource.Type !== "AWS::Lambda::EventSourceMapping") {
      continue;
    }
    const sourceArn = resource.Properties?.EventSourceArn;
    const channel = resolveQueueChannel(sourceArn);
    if (channel === null) {
      continue;
    }
    const fnRef = resource.Properties?.FunctionName;
    const lambdaId = refTarget(fnRef);
    if (lambdaId === null) {
      continue;
    }
    const lambdaResource = resources[lambdaId];
    if (lambdaResource === undefined) {
      continue;
    }
    summaries.push(
      buildLambdaConsumerSummary({
        lambdaId,
        lambdaResource,
        eventName: "EventSourceMapping",
        channel,
        sourceFile,
      }),
    );
  }

  return summaries;
}

function buildQueueProviderSummary(
  logicalId: string,
  resource: CloudFormationResource,
  sourceFile: string,
): BehavioralSummary {
  const fifoQueue = resource.Properties?.FifoQueue === true;
  return {
    kind: "library",
    location: {
      file: sourceFile,
      range: { start: 1, end: 1 },
      exportName: null,
    },
    identity: {
      name: logicalId,
      exportPath: null,
      boundaryBinding: messageBusBinding({
        recognition: "cloudformation",
        messageBus: "sqs",
        channel: logicalId,
      }),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: {
      messageBus: {
        fifoQueue,
        ...(typeof resource.Properties?.QueueName === "string"
          ? { physicalName: resource.Properties.QueueName }
          : {}),
      },
    },
  };
}

interface LambdaConsumerOpts {
  lambdaId: string;
  lambdaResource: CloudFormationResource;
  eventName: string;
  channel: string;
  sourceFile: string;
}

function buildLambdaConsumerSummary(
  opts: LambdaConsumerOpts,
): BehavioralSummary {
  // Mirror the codeScope shape runtime-config emits so a downstream
  // pairing pass can scope code reads to this consumer's source files.
  const codeUri = opts.lambdaResource.Properties?.CodeUri;
  const codeScope =
    typeof codeUri === "string"
      ? { kind: "codeUri", path: normalizeCodeUri(codeUri) }
      : { kind: "unknown" };
  return {
    kind: "consumer",
    location: {
      file: opts.sourceFile,
      range: { start: 1, end: 1 },
      exportName: null,
    },
    identity: {
      // Compose the lambda's logical id with the event name so multiple
      // events on one Lambda produce distinguishable summaries.
      name: `${opts.lambdaId}.${opts.eventName}`,
      exportPath: null,
      boundaryBinding: messageBusBinding({
        recognition: "cloudformation",
        messageBus: "sqs",
        channel: opts.channel,
      }),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: {
      codeScope,
      messageBus: {
        consumerLambda: opts.lambdaId,
        eventName: opts.eventName,
      },
    },
  };
}

/**
 * Resolve a Queue reference (`!Ref X`, `!GetAtt X.Arn`, plain string
 * ARN) to the queue's CFN logical resource id.
 *
 * Returns null when the reference is dynamic (a parameter / import /
 * fn::join with no obvious target) — those need cross-stack resolution
 * that's out of scope for v0.
 */
function resolveQueueChannel(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    // Plain string: either the ARN of an external queue (we can't
    // resolve that to a logical id without the deployed stack) or, in
    // tests, a logical id passed directly.
    const arnMatch = value.match(/:sqs:[^:]+:[^:]+:([^/]+)$/);
    if (arnMatch !== null) {
      return arnMatch[1];
    }
    return value;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if ("Ref" in obj && typeof obj.Ref === "string") {
      return obj.Ref;
    }
    if ("Fn::GetAtt" in obj) {
      const att = obj["Fn::GetAtt"];
      if (Array.isArray(att) && typeof att[0] === "string") {
        return att[0];
      }
      if (typeof att === "string") {
        // Short-form: "Resource.Attribute"
        const dot = att.indexOf(".");
        if (dot !== -1) {
          return att.slice(0, dot);
        }
      }
    }
  }
  return null;
}

function refTarget(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if ("Ref" in obj && typeof obj.Ref === "string") {
      return obj.Ref;
    }
  }
  return null;
}

function normalizeCodeUri(raw: string): string {
  // Match runtime-config's logic — strip ./ prefix, ensure trailing /
  // for directory-style paths.
  let path = raw;
  if (path.startsWith("./")) {
    path = path.slice(2);
  }
  if (!path.endsWith("/")) {
    path = `${path}/`;
  }
  return path;
}
