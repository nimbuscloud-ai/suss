/**
 * Summaries for the places a template moves messages from one resource
 * to another with no code doing it: a queue's redrive policy, a
 * function's dead-letter queue and destinations, an SNS subscription or
 * an S3 notification that delivers into a queue or a topic.
 *
 * Each one has a `message-send` effect on the channel the messages
 * arrive at, with the binding the aws-sqs and aws-sns packs give a send
 * in code, so a dead-letter queue has a producer. A wire that also takes
 * messages off a channel is a consumer of it. The README explains how
 * the checker counts them. EventBridge rule targets are built with the
 * rule's other summaries, since their channel comes from the pattern.
 */

import { messageBusBinding, withMessageBusMetadata } from "@suss/behavioral-ir";
import { formatChannel } from "@suss/ir-core";
import {
  refTarget,
  resolveEventBusToken,
  resolveQueueChannel,
  resolveTopicChannel,
} from "@suss/manifest-aws";

import { locationOf, type TemplatePlace } from "./templatePlace.js";

import type {
  BehavioralSummary,
  MessageBusMetadata,
  MessageBusSemantics,
} from "@suss/behavioral-ir";

interface CloudFormationResource {
  Type?: string;
  Properties?: Record<string, unknown>;
  Metadata?: Record<string, unknown>;
}

type Wiring = NonNullable<MessageBusMetadata["wiring"]>;

/** One side of a wire: a channel, bound the way the code packs bind one. */
export interface WireEnd {
  messageBus: MessageBusSemantics["messageBus"];
  channel: string;
}

/** Where a wire delivers to, and the source its messages carry, when one is known. */
export interface WireTarget extends WireEnd {
  routingKey?: string;
}

export interface Wire {
  /** Says which resource and property declared the wire. */
  name: string;
  /** The resource whose line the summary points at. */
  declaredAt: string;
  wiring: Wiring;
  /** The channel the wire takes messages off, or null when it takes none. */
  from: WireEnd | null;
  /** Where the messages go, or null when that is not a channel suss reads. */
  to: WireTarget | null;
  /** Other message-bus metadata the consumer side records, such as its rule. */
  metadata?: MessageBusMetadata;
}

export function wireSummary(
  wire: Wire,
  place: TemplatePlace,
  recognition: string,
): BehavioralSummary {
  const location = locationOf(place, wire.declaredAt);
  return {
    // A redrive takes nothing off a channel, so it is a fact about the
    // template, the kind the reader gives its other edges.
    kind: wire.from === null ? "library" : "consumer",
    location,
    identity: {
      name: wire.name,
      exportPath: null,
      boundaryBinding:
        wire.from === null
          ? null
          : messageBusBinding({
              recognition,
              messageBus: wire.from.messageBus,
              channel: wire.from.channel,
            }),
    },
    inputs: [],
    transitions:
      wire.to === null
        ? []
        : [deliveryTransition(wire, wire.to, location.range, recognition)],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: withMessageBusMetadata(undefined, {
      ...wire.metadata,
      wiring: wire.wiring,
    }),
  };
}

function deliveryTransition(
  wire: Wire,
  to: WireTarget,
  lines: { start: number; end: number },
  recognition: string,
): BehavioralSummary["transitions"][number] {
  return {
    id: `${wire.name}:delivers`,
    conditions: [],
    output: { type: "void" },
    effects: [
      {
        type: "interaction",
        binding: messageBusBinding({
          recognition,
          messageBus: to.messageBus,
          channel: to.channel,
        }),
        interaction: {
          class: "message-send",
          ...(to.routingKey === undefined ? {} : { routingKey: to.routingKey }),
        },
      },
    ],
    location: lines,
    isDefault: true,
  };
}

/**
 * Where a reference to a queue or a topic delivers, when the template
 * declares that resource. An ARN or a name the template does not
 * declare could be anything, so it gives null.
 */
export function channelTargetOf(
  ref: unknown,
  resources: Record<string, CloudFormationResource>,
): WireTarget | null {
  const queue = resolveQueueChannel(ref);
  if (queue !== null && resources[queue]?.Type === "AWS::SQS::Queue") {
    return { messageBus: "aws_sqs", channel: queue };
  }
  const topic = resolveTopicChannel(ref);
  if (topic !== null && resources[topic]?.Type === "AWS::SNS::Topic") {
    return { messageBus: "aws.sns", channel: topic };
  }

  return null;
}

/** The bus token of a declared event bus a reference points at, or null. */
export function eventBusTargetOf(
  ref: unknown,
  resources: Record<string, CloudFormationResource>,
): string | null {
  const id = refTarget(ref);
  if (id === null || resources[id]?.Type !== "AWS::Events::EventBus") {
    return null;
  }

  return resolveEventBusToken(ref);
}

/** Every wire in the template that does not come from an EventBridge rule. */
export function buildWiringSummaries(
  resources: Record<string, CloudFormationResource>,
  place: TemplatePlace,
  recognition: string,
): BehavioralSummary[] {
  const wires: Wire[] = [];
  for (const [logicalId, resource] of Object.entries(resources)) {
    const read = WIRES_BY_TYPE[resource.Type ?? ""];
    if (read !== undefined) {
      wires.push(...read(logicalId, resource, resources));
    }
  }

  return wires.map((wire) => wireSummary(wire, place, recognition));
}

type WireReader = (
  logicalId: string,
  resource: CloudFormationResource,
  resources: Record<string, CloudFormationResource>,
) => Wire[];

const WIRES_BY_TYPE: Record<string, WireReader> = {
  "AWS::SQS::Queue": queueRedrive,
  "AWS::SNS::Subscription": standaloneSubscription,
  "AWS::SNS::Topic": inlineSubscriptions,
  "AWS::S3::Bucket": bucketNotifications,
  "AWS::Lambda::Function": functionDeliveries,
  "AWS::Serverless::Function": functionDeliveries,
  "AWS::Lambda::EventInvokeConfig": invokeConfigDestinations,
  "AWS::Lambda::EventSourceMapping": eventSourceMappingFailures,
  "AWS::Pipes::Pipe": pipeDelivery,
  "AWS::Scheduler::Schedule": scheduleDelivery,
  "AWS::CloudWatch::Alarm": alarmActions,
};

/**
 * A pipe takes messages off its source and puts them on its target. A
 * stream source is not a channel, so that pipe only delivers. An event
 * forwarded to a bus gets the detail-type and source the pipe sets.
 */
function pipeDelivery(
  logicalId: string,
  resource: CloudFormationResource,
  resources: Record<string, CloudFormationResource>,
): Wire[] {
  const props = resource.Properties ?? {};
  const source = channelTargetOf(props.Source, resources);
  const from = source?.messageBus === "aws_sqs" ? source : null;
  const to = forwardTarget(
    props.Target,
    propertyOf(props.TargetParameters, "EventBridgeEventBusParameters"),
    resources,
  );
  // Only a stream source has a dead-letter queue, and a pipe has one source.
  const streamParameters = Object.values(
    (propertyOf(props, "SourceParameters") ?? {}) as Record<string, unknown>,
  );
  return [
    ...(from === null && to === null
      ? []
      : [
          {
            name: logicalId,
            declaredAt: logicalId,
            wiring: "pipe" as const,
            from,
            to,
          },
        ]),
    ...streamParameters.flatMap((parameters) =>
      deadLetterWire({
        name: `${logicalId}.DeadLetterConfig`,
        declaredAt: logicalId,
        wiring: "deadLetter",
        ref: propertyOf(propertyOf(parameters, "DeadLetterConfig"), "Arn"),
        resources,
      }),
    ),
  ];
}

/**
 * A schedule sends its own payload to its target on time, and what it
 * could not deliver to its dead-letter queue.
 */
function scheduleDelivery(
  logicalId: string,
  resource: CloudFormationResource,
  resources: Record<string, CloudFormationResource>,
): Wire[] {
  const target = resource.Properties?.Target;
  const to = forwardTarget(
    propertyOf(target, "Arn"),
    propertyOf(target, "EventBridgeParameters"),
    resources,
  );
  return [
    ...(to === null
      ? []
      : [
          {
            name: logicalId,
            declaredAt: logicalId,
            wiring: "schedule" as const,
            from: null,
            to,
          },
        ]),
    ...deadLetterWire({
      name: `${logicalId}.DeadLetterConfig`,
      declaredAt: logicalId,
      wiring: "deadLetter",
      ref: propertyOf(propertyOf(target, "DeadLetterConfig"), "Arn"),
      resources,
    }),
  ];
}

/** An alarm publishes to each topic in its actions when its state changes. */
function alarmActions(
  logicalId: string,
  resource: CloudFormationResource,
  resources: Record<string, CloudFormationResource>,
): Wire[] {
  const props = resource.Properties ?? {};
  const refs = ["AlarmActions", "OKActions", "InsufficientDataActions"].flatMap(
    (key) => (Array.isArray(props[key]) ? (props[key] as unknown[]) : []),
  );
  const topics = new Set(
    refs
      .map((ref) => channelTargetOf(ref, resources))
      .filter((to): to is WireTarget => to?.messageBus === "aws.sns")
      .map((to) => to.channel),
  );
  return [...topics].map((topic) => ({
    name: `${logicalId}.${topic}`,
    declaredAt: logicalId,
    wiring: "alarm" as const,
    from: null,
    to: { messageBus: "aws.sns" as const, channel: topic },
  }));
}

/**
 * A queue or topic target, or a bus with the detail-type and source the
 * resource sets on what it forwards. A bus with no literal detail-type
 * is not a channel suss can name.
 */
function forwardTarget(
  ref: unknown,
  busParameters: unknown,
  resources: Record<string, CloudFormationResource>,
): WireTarget | null {
  const channel = channelTargetOf(ref, resources);
  if (channel !== null) {
    return channel;
  }
  const bus = eventBusTargetOf(ref, resources);
  const detailType = propertyOf(busParameters, "DetailType");
  if (bus === null || typeof detailType !== "string") {
    return null;
  }
  const source = propertyOf(busParameters, "Source");
  return {
    messageBus: "eventbridge",
    channel: formatChannel(bus, detailType),
    ...(typeof source === "string" ? { routingKey: source } : {}),
  };
}

/** SQS moves a message it could not deliver to the queue the RedrivePolicy points at. */
function queueRedrive(
  logicalId: string,
  resource: CloudFormationResource,
  resources: Record<string, CloudFormationResource>,
): Wire[] {
  return deadLetterWire({
    name: `${logicalId}.RedrivePolicy`,
    declaredAt: logicalId,
    wiring: "redrive",
    ref: redriveTarget(resource.Properties?.RedrivePolicy),
    resources,
  });
}

/** The `deadLetterTargetArn` of a RedrivePolicy, which SQS and SNS both write. */
function redriveTarget(policy: unknown): unknown {
  if (policy === null || typeof policy !== "object") {
    return undefined;
  }

  return (policy as Record<string, unknown>).deadLetterTargetArn;
}

function deadLetterWire(opts: {
  name: string;
  declaredAt: string;
  wiring: Wiring;
  ref: unknown;
  resources: Record<string, CloudFormationResource>;
}): Wire[] {
  const to = channelTargetOf(opts.ref, opts.resources);
  if (to === null) {
    return [];
  }

  return [
    {
      name: opts.name,
      declaredAt: opts.declaredAt,
      wiring: opts.wiring,
      from: null,
      to,
    },
  ];
}

function standaloneSubscription(
  logicalId: string,
  resource: CloudFormationResource,
  resources: Record<string, CloudFormationResource>,
): Wire[] {
  const props = resource.Properties ?? {};
  const topic = resolveTopicChannel(props.TopicArn);
  if (topic === null) {
    return [];
  }
  return [
    ...subscriptionDelivery({
      label: logicalId,
      declaredAt: logicalId,
      topic,
      protocol: props.Protocol,
      endpoint: props.Endpoint,
      resources,
    }),
    ...deadLetterWire({
      name: `${logicalId}.RedrivePolicy`,
      declaredAt: logicalId,
      wiring: "deadLetter",
      ref: redriveTarget(props.RedrivePolicy),
      resources,
    }),
  ];
}

function inlineSubscriptions(
  logicalId: string,
  resource: CloudFormationResource,
  resources: Record<string, CloudFormationResource>,
): Wire[] {
  const inline = resource.Properties?.Subscription;
  if (!Array.isArray(inline)) {
    return [];
  }
  return inline.flatMap((entry: unknown, index) => {
    if (entry === null || typeof entry !== "object") {
      return [];
    }
    const record = entry as Record<string, unknown>;
    return subscriptionDelivery({
      label: `${logicalId}.Subscription${index}`,
      declaredAt: logicalId,
      topic: logicalId,
      protocol: record.Protocol,
      endpoint: record.Endpoint,
      resources,
    });
  });
}

/**
 * A subscription with protocol `sqs` puts the topic's messages on the
 * queue. A `lambda` subscription is a consumer the message-bus reader
 * builds already, and other protocols leave AWS.
 */
function subscriptionDelivery(opts: {
  label: string;
  declaredAt: string;
  topic: string;
  protocol: unknown;
  endpoint: unknown;
  resources: Record<string, CloudFormationResource>;
}): Wire[] {
  if (opts.protocol !== "sqs") {
    return [];
  }
  const queue = resolveQueueChannel(opts.endpoint);
  if (queue === null || opts.resources[queue]?.Type !== "AWS::SQS::Queue") {
    return [];
  }
  return [
    {
      name: opts.label,
      declaredAt: opts.declaredAt,
      wiring: "subscription",
      from: { messageBus: "aws.sns", channel: opts.topic },
      to: { messageBus: "aws_sqs", channel: queue },
      metadata: { subscription: opts.label },
    },
  ];
}

const NOTIFICATION_TARGETS: Record<string, string> = {
  QueueConfigurations: "Queue",
  TopicConfigurations: "Topic",
};

/**
 * A bucket's QueueConfiguration and TopicConfiguration deliver its
 * events to a queue or a topic. A LambdaConfiguration is a consumer the
 * message-bus reader builds already.
 */
function bucketNotifications(
  logicalId: string,
  resource: CloudFormationResource,
  resources: Record<string, CloudFormationResource>,
): Wire[] {
  const config = resource.Properties?.NotificationConfiguration;
  if (config === null || typeof config !== "object") {
    return [];
  }
  const wires: Wire[] = [];
  for (const [list, property] of Object.entries(NOTIFICATION_TARGETS)) {
    const entries = (config as Record<string, unknown>)[list];
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const [index, entry] of entries.entries()) {
      if (entry === null || typeof entry !== "object") {
        continue;
      }
      const record = entry as Record<string, unknown>;
      const to = channelTargetOf(record[property], resources);
      if (to === null) {
        continue;
      }
      const label = `${logicalId}.${list.slice(0, -1)}${index}`;
      wires.push({
        name: label,
        declaredAt: logicalId,
        wiring: "notification",
        from: { messageBus: "s3", channel: logicalId },
        to,
        metadata: {
          notification: label,
          ...(typeof record.Event === "string"
            ? { events: [record.Event] }
            : {}),
        },
      });
    }
  }

  return wires;
}

/**
 * A function sends an event it gave up on to its dead-letter queue, and
 * the result of an asynchronous invocation to its destinations. SAM
 * writes both on the function. Plain CloudFormation writes the
 * dead-letter target there and the destinations on an EventInvokeConfig.
 */
function functionDeliveries(
  logicalId: string,
  resource: CloudFormationResource,
  resources: Record<string, CloudFormationResource>,
): Wire[] {
  const props = resource.Properties ?? {};
  const deadLetter = props.DeadLetterQueue ?? props.DeadLetterConfig;
  const invokeConfig = props.EventInvokeConfig;
  return [
    ...deadLetterWire({
      name: `${logicalId}.DeadLetterQueue`,
      declaredAt: logicalId,
      wiring: "deadLetter",
      ref: propertyOf(deadLetter, "TargetArn"),
      resources,
    }),
    ...destinationWires(
      logicalId,
      logicalId,
      propertyOf(invokeConfig, "DestinationConfig"),
      resources,
    ),
    ...samEventFailures(logicalId, props.Events, resources),
  ];
}

function propertyOf(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") {
    return undefined;
  }

  return (value as Record<string, unknown>)[key];
}

function invokeConfigDestinations(
  logicalId: string,
  resource: CloudFormationResource,
  resources: Record<string, CloudFormationResource>,
): Wire[] {
  const fn = refTarget(resource.Properties?.FunctionName);
  return destinationWires(
    fn ?? logicalId,
    logicalId,
    resource.Properties?.DestinationConfig,
    resources,
  );
}

/**
 * What Lambda puts on an event bus for the result of an asynchronous
 * invocation. The detail-type says which outcome, and the source is
 * always `lambda`.
 */
const DESTINATION_DETAIL_TYPES: Record<string, string> = {
  OnSuccess: "Lambda Function Invocation Result - Success",
  OnFailure: "Lambda Function Invocation Result - Failure",
};

function destinationWires(
  functionId: string,
  declaredAt: string,
  config: unknown,
  resources: Record<string, CloudFormationResource>,
): Wire[] {
  const wires: Wire[] = [];
  for (const [outcome, detailType] of Object.entries(
    DESTINATION_DETAIL_TYPES,
  )) {
    const ref = propertyOf(propertyOf(config, outcome), "Destination");
    const to = destinationTarget(ref, detailType, resources);
    if (to === null) {
      continue;
    }
    wires.push({
      name: `${functionId}.${outcome}`,
      declaredAt,
      wiring: "destination",
      from: null,
      to,
    });
  }

  return wires;
}

function destinationTarget(
  ref: unknown,
  detailType: string,
  resources: Record<string, CloudFormationResource>,
): WireTarget | null {
  const channel = channelTargetOf(ref, resources);
  if (channel !== null) {
    return channel;
  }
  const bus = eventBusTargetOf(ref, resources);
  if (bus === null) {
    return null;
  }

  return {
    messageBus: "eventbridge",
    channel: formatChannel(bus, detailType),
    routingKey: "lambda",
  };
}

/** A mapping sends a batch it could not process to its OnFailure destination. */
function eventSourceMappingFailures(
  logicalId: string,
  resource: CloudFormationResource,
  resources: Record<string, CloudFormationResource>,
): Wire[] {
  return failureDestination(
    `${logicalId}.OnFailure`,
    logicalId,
    resource.Properties?.DestinationConfig,
    resources,
  );
}

/**
 * SAM's stream and queue events take the same DestinationConfig as a
 * mapping. Its rule and schedule events take a DeadLetterConfig.
 */
function samEventFailures(
  functionId: string,
  events: unknown,
  resources: Record<string, CloudFormationResource>,
): Wire[] {
  if (events === null || typeof events !== "object") {
    return [];
  }
  return Object.entries(events as Record<string, unknown>).flatMap(
    ([eventName, event]) => {
      const props = propertyOf(event, "Properties");
      return [
        ...failureDestination(
          `${functionId}.${eventName}.OnFailure`,
          functionId,
          propertyOf(props, "DestinationConfig"),
          resources,
        ),
        ...deadLetterWire({
          name: `${functionId}.${eventName}.DeadLetterConfig`,
          declaredAt: functionId,
          wiring: "deadLetter",
          ref: propertyOf(propertyOf(props, "DeadLetterConfig"), "Arn"),
          resources,
        }),
      ];
    },
  );
}

function failureDestination(
  name: string,
  declaredAt: string,
  config: unknown,
  resources: Record<string, CloudFormationResource>,
): Wire[] {
  return deadLetterWire({
    name,
    declaredAt,
    wiring: "deadLetter",
    ref: propertyOf(propertyOf(config, "OnFailure"), "Destination"),
    resources,
  });
}
