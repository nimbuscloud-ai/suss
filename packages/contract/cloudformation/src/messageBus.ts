/**
 * Provider and consumer summaries for SQS queues, SNS topics,
 * EventBridge rules and S3 bucket notifications. The README describes
 * the channel each family uses.
 *
 * A provider summary (kind library) says a channel exists, and producers
 * in code pair with it. A consumer summary (kind consumer) says a Lambda
 * receives from a channel, and has the same channel as the provider. A
 * queue's consumers take the channel of the single subject routed into
 * the queue, when there is one, so a producer upstream pairs with the
 * Lambda that ends up handling its message.
 */

import { messageBusBinding, withMessageBusMetadata } from "@suss/behavioral-ir";
import { formatChannel } from "@suss/ir-core";
import {
  type EventPatternFields,
  readEventPattern,
  refTarget,
  resolveBucketChannel,
  resolveEventBusToken,
  resolveQueueChannel,
  resolveTopicChannel,
} from "@suss/manifest-aws";

import {
  buildWiringSummaries,
  channelTargetOf,
  eventBusTargetOf,
  type Wire,
  type WireTarget,
  wireSummary,
} from "./messageWiring.js";
import { readCodeScope } from "./runtimeConfig.js";
import {
  locationOf,
  type TemplatePlace,
  templatePlace,
} from "./templatePlace.js";

import type {
  BehavioralSummary,
  MessageBusMetadata,
} from "@suss/behavioral-ir";

interface CloudFormationResource {
  Type?: string;
  Properties?: Record<string, unknown>;
  Metadata?: Record<string, unknown>;
}

type EventPatternMetadata = NonNullable<MessageBusMetadata["eventPattern"]>;

/**
 * The subject of a rule's channel when its pattern lists no literal
 * detail-types. The rule's `eventPattern` metadata decides which sends
 * reach it.
 */
export const PATTERN_SUBJECT = "<pattern>";

/**
 * Every message-bus provider and consumer summary in the template.
 * Producers in code come from the aws-sqs, aws-sns and aws-eventbridge
 * packs. The template's own deliveries are summaries with a send effect.
 *
 * A consumer's `metadata.codeScope` matches its function's runtime-config
 * summary, so code reads can be scoped to the consumer. When a queue's
 * consumer takes an upstream subject's channel, the queue's logical id
 * moves to `metadata.messageBus.queue`, so accounting per queue still
 * sees the consumer. `lines` gives each summary its resource's line.
 */
export function buildMessageBusSummaries(
  resources: Record<string, CloudFormationResource>,
  sourceFile: string,
  recognition = "cloudformation",
  lines?: ReadonlyMap<string, number>,
): BehavioralSummary[] {
  const place = templatePlace(sourceFile, lines);
  const summaries: BehavioralSummary[] = [];
  const snsSubscriptions = collectSnsSubscriptions(resources);
  const s3Notifications = collectS3Notifications(resources);
  const queueSubjects = buildQueueSubjectMap(
    resources,
    snsSubscriptions,
    s3Notifications.queue,
  );
  // SAM adds a NotificationConfiguration to each bucket a Type: S3 event
  // refers to when it deploys, so step 6 gives those buckets a provider.
  const samS3Buckets = new Set<string>();

  // 1. Provider summaries: one per AWS::SQS::Queue.
  for (const [logicalId, resource] of Object.entries(resources)) {
    if (resource.Type !== "AWS::SQS::Queue") {
      continue;
    }
    summaries.push(
      buildQueueProviderSummary(logicalId, resource, place, recognition),
    );
  }

  // 2. Consumers from SAM `Events` entries of type SQS, SNS and S3.
  for (const [logicalId, resource] of Object.entries(resources)) {
    if (resource.Type !== "AWS::Serverless::Function") {
      continue;
    }
    const events = resource.Properties?.Events;
    if (events === null || typeof events !== "object") {
      continue;
    }
    for (const [eventName, eventDefRaw] of Object.entries(
      events as Record<string, unknown>,
    )) {
      if (eventDefRaw === null || typeof eventDefRaw !== "object") {
        continue;
      }
      const eventDef = eventDefRaw as {
        Type?: string;
        Properties?: Record<string, unknown>;
      };
      if (eventDef.Type === "SQS") {
        const channel = resolveQueueChannel(eventDef.Properties?.Queue);
        if (channel === null) {
          continue;
        }
        summaries.push(
          buildLambdaConsumerSummary({
            lambdaId: logicalId,
            lambdaResource: resource,
            eventName,
            channel,
            routed: singleRoutedSubjectOf(queueSubjects, channel),
            declaredAt: logicalId,
            place,
            recognition,
          }),
        );
        continue;
      }
      if (eventDef.Type === "SNS") {
        const topicId = resolveTopicChannel(eventDef.Properties?.Topic);
        if (topicId === null) {
          continue;
        }
        summaries.push(
          buildSnsLambdaConsumerSummary({
            lambdaId: logicalId,
            lambdaResource: resource,
            label: eventName,
            topicId,
            filterPolicy: eventDef.Properties?.FilterPolicy,
            sqsSubscription: eventDef.Properties?.SqsSubscription,
            declaredAt: logicalId,
            place,
            recognition,
          }),
        );
        continue;
      }
      if (eventDef.Type === "S3") {
        const bucketId = resolveBucketChannel(eventDef.Properties?.Bucket);
        if (bucketId === null) {
          continue;
        }
        samS3Buckets.add(bucketId);
        summaries.push(
          buildS3LambdaConsumerSummary({
            lambdaId: logicalId,
            lambdaResource: resource,
            label: eventName,
            bucketId,
            event: eventDef.Properties?.Events,
            filter: eventDef.Properties?.Filter,
            declaredAt: logicalId,
            place,
            recognition,
          }),
        );
      }
    }
  }

  // 3. Consumers from an EventSourceMapping, which plain CloudFormation
  //    declares where SAM would use an SQS event.
  for (const [mappingId, resource] of Object.entries(resources)) {
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
        routed: singleRoutedSubjectOf(queueSubjects, channel),
        declaredAt: mappingId,
        place,
        recognition,
      }),
    );
  }

  // 4. EventBridge rules and SAM EventBridgeRule and Schedule events.
  summaries.push(...buildEventBridgeSummaries(resources, place, recognition));

  // 5. SNS topics, and a consumer per "lambda" subscription. An "sqs"
  //    subscription is a wire, and other protocols do not reach code.
  for (const [logicalId, resource] of Object.entries(resources)) {
    if (resource.Type !== "AWS::SNS::Topic") {
      continue;
    }
    summaries.push(
      buildTopicProviderSummary(logicalId, resource, place, recognition),
    );
  }
  for (const sub of snsSubscriptions) {
    if (sub.protocol !== "lambda") {
      continue;
    }
    const lambdaId = refTarget(sub.endpoint);
    if (lambdaId === null) {
      continue;
    }
    const lambdaResource = resources[lambdaId];
    if (lambdaResource === undefined || !isFunction(lambdaResource)) {
      continue;
    }
    summaries.push(
      buildSnsLambdaConsumerSummary({
        lambdaId,
        lambdaResource,
        label: sub.label,
        topicId: sub.topicId,
        filterPolicy: sub.filterPolicy,
        declaredAt: sub.declaredAt,
        place,
        recognition,
      }),
    );
  }

  // 6. Buckets with a notification, and their Lambda consumers. A
  //    QueueConfiguration or TopicConfiguration is a wire.
  const notifiedBuckets = new Set([
    ...s3Notifications.lambda.map((n) => n.bucketId),
    ...s3Notifications.queue.map((n) => n.bucketId),
    ...s3Notifications.topic.map((n) => n.bucketId),
    ...[...samS3Buckets].filter(
      (bucketId) => resources[bucketId]?.Type === "AWS::S3::Bucket",
    ),
  ]);
  for (const bucketId of notifiedBuckets) {
    // Every id here is a declared AWS::S3::Bucket, so the lookup succeeds.
    summaries.push(
      buildBucketProviderSummary(
        bucketId,
        resources[bucketId],
        place,
        recognition,
      ),
    );
  }
  for (const notification of s3Notifications.lambda) {
    const lambdaId = refTarget(notification.functionRef);
    if (lambdaId === null) {
      continue;
    }
    const lambdaResource = resources[lambdaId];
    if (lambdaResource === undefined || !isFunction(lambdaResource)) {
      continue;
    }
    summaries.push(
      buildS3LambdaConsumerSummary({
        lambdaId,
        lambdaResource,
        label: notification.label,
        bucketId: notification.bucketId,
        event: notification.event,
        filter: notification.filter,
        declaredAt: notification.bucketId,
        place,
        recognition,
      }),
    );
  }

  // 7. Deliveries the template makes with no code doing them.
  summaries.push(...buildWiringSummaries(resources, place, recognition));

  return summaries;
}

function isFunction(resource: CloudFormationResource): boolean {
  return (
    resource.Type === "AWS::Serverless::Function" ||
    resource.Type === "AWS::Lambda::Function"
  );
}

function buildQueueProviderSummary(
  logicalId: string,
  resource: CloudFormationResource,
  place: TemplatePlace,
  recognition: string,
): BehavioralSummary {
  const fifoQueue = resource.Properties?.FifoQueue === true;
  return {
    kind: "library",
    location: locationOf(place, logicalId),
    identity: {
      name: logicalId,
      exportPath: null,
      boundaryBinding: messageBusBinding({
        recognition,
        messageBus: "aws_sqs",
        channel: logicalId,
      }),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: withMessageBusMetadata(undefined, {
      fifoQueue,
      ...(typeof resource.Properties?.QueueName === "string"
        ? { physicalName: resource.Properties.QueueName }
        : {}),
    }),
  };
}

function buildTopicProviderSummary(
  logicalId: string,
  resource: CloudFormationResource,
  place: TemplatePlace,
  recognition: string,
): BehavioralSummary {
  const fifoTopic = resource.Properties?.FifoTopic === true;
  return {
    kind: "library",
    location: locationOf(place, logicalId),
    identity: {
      name: logicalId,
      exportPath: null,
      boundaryBinding: messageBusBinding({
        recognition,
        messageBus: "aws.sns",
        channel: logicalId,
      }),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: withMessageBusMetadata(undefined, {
      fifoTopic,
      ...(typeof resource.Properties?.TopicName === "string"
        ? { physicalName: resource.Properties.TopicName }
        : {}),
    }),
  };
}

/** Where a consumer summary points a reader: the resource that wires it. */
interface Declared {
  declaredAt: string;
  place: TemplatePlace;
  recognition: string;
}

interface LambdaConsumerOpts extends Declared {
  lambdaId: string;
  lambdaResource: CloudFormationResource;
  eventName: string;
  // The queue's logical id.
  channel: string;
  // Null when no subject, or more than one, is routed into the queue.
  routed: RoutedSubject | null;
}

function buildLambdaConsumerSummary(
  opts: LambdaConsumerOpts,
): BehavioralSummary {
  const codeScope = readCodeScope(opts.lambdaResource);
  return {
    kind: "consumer",
    location: locationOf(opts.place, opts.declaredAt),
    identity: {
      // The event name keeps several events on one Lambda apart.
      name: `${opts.lambdaId}.${opts.eventName}`,
      exportPath: null,
      boundaryBinding: messageBusBinding({
        recognition: opts.recognition,
        messageBus: "aws_sqs",
        channel: opts.routed?.channel ?? opts.channel,
      }),
      deployableUnit: {
        deploymentTarget: "lambda",
        instanceName: opts.lambdaId,
      },
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: withMessageBusMetadata(
      { codeScope },
      {
        eventName: opts.eventName,
        ...(opts.routed !== null
          ? {
              queue: opts.channel,
              ...(opts.routed.detailType !== undefined
                ? { subject: opts.routed.detailType }
                : {}),
              ...(opts.routed.eventBus !== undefined
                ? { eventBus: opts.routed.eventBus }
                : {}),
              ...(opts.routed.eventPattern !== undefined
                ? { eventPattern: opts.routed.eventPattern }
                : {}),
            }
          : {}),
      },
    ),
  };
}

// A subject routed into a queue from an EventBridge rule, an SNS topic or
// an S3 bucket. `eventBus`, `detailType` and `eventPattern` are only set
// for a rule.
interface RoutedSubject {
  // `<bus>#<detailType>` for a rule, or the topic's or bucket's logical id.
  channel: string;
  eventBus?: string;
  detailType?: string;
  eventPattern?: EventPatternMetadata;
}

// The subjects routed into each queue. Two rules routing one subject
// with different patterns count twice. A rule's DeadLetterConfig queue
// gets failed deliveries only, so only a target's own `Arn` counts.
function buildQueueSubjectMap(
  resources: Record<string, CloudFormationResource>,
  snsSubscriptions: SnsSubscription[],
  s3QueueNotifications: S3QueueNotification[],
): Map<string, Map<string, RoutedSubject>> {
  const map = new Map<string, Map<string, RoutedSubject>>();
  for (const [, resource] of Object.entries(resources)) {
    if (resource.Type !== "AWS::Events::Rule") {
      continue;
    }
    const scheduleExpr = resource.Properties?.ScheduleExpression;
    if (typeof scheduleExpr === "string" && scheduleExpr.length > 0) {
      continue;
    }
    const pattern = readEventPattern(resource.Properties?.EventPattern);
    if (pattern?.detailTypes === undefined) {
      continue;
    }
    const targets = resource.Properties?.Targets;
    if (!Array.isArray(targets)) {
      continue;
    }
    const eventBus = resolveEventBusToken(resource.Properties?.EventBusName);
    for (const target of targets) {
      if (target === null || typeof target !== "object") {
        continue;
      }
      const queueId = resolveQueueChannel((target as { Arn?: unknown }).Arn);
      if (queueId === null || resources[queueId]?.Type !== "AWS::SQS::Queue") {
        continue;
      }
      const routed = map.get(queueId) ?? new Map<string, RoutedSubject>();
      for (const detailType of pattern.detailTypes) {
        const channel = formatChannel(eventBus, detailType);
        const eventPattern = channelPattern(pattern, { detailType });
        routed.set(`${channel}\0${JSON.stringify(eventPattern)}`, {
          channel,
          eventBus,
          detailType,
          eventPattern,
        });
      }
      map.set(queueId, routed);
    }
  }

  // A filter narrows which messages reach the queue, and filters are not
  // reduced yet, so a filtered subscription or notification is left out.
  for (const sub of snsSubscriptions) {
    if (sub.protocol !== "sqs" || sub.filterPolicy !== undefined) {
      continue;
    }
    const queueId = resolveQueueChannel(sub.endpoint);
    if (queueId === null || resources[queueId]?.Type !== "AWS::SQS::Queue") {
      continue;
    }
    const routed = map.get(queueId) ?? new Map<string, RoutedSubject>();
    routed.set(sub.topicId, { channel: sub.topicId });
    map.set(queueId, routed);
  }

  for (const notification of s3QueueNotifications) {
    if (notification.filter !== undefined) {
      continue;
    }
    const queueId = resolveQueueChannel(notification.queueRef);
    if (queueId === null || resources[queueId]?.Type !== "AWS::SQS::Queue") {
      continue;
    }
    const routed = map.get(queueId) ?? new Map<string, RoutedSubject>();
    routed.set(notification.bucketId, { channel: notification.bucketId });
    map.set(queueId, routed);
  }

  return map;
}

// With several subjects, no single one describes the queue's messages.
function singleRoutedSubjectOf(
  queueSubjects: Map<string, Map<string, RoutedSubject>>,
  queueId: string,
): RoutedSubject | null {
  const routed = queueSubjects.get(queueId);
  if (routed === undefined || routed.size !== 1) {
    return null;
  }
  return [...routed.values()][0] ?? null;
}

// ---------------------------------------------------------------------------
// EventBridge
// ---------------------------------------------------------------------------

/** What the checker needs from a pattern, with empty parts left out. */
function patternMetadata(fields: EventPatternFields): EventPatternMetadata {
  return {
    ...(fields.detailTypes !== undefined
      ? { detailTypes: fields.detailTypes }
      : {}),
    ...(fields.sources !== undefined ? { sources: fields.sources } : {}),
    ...(fields.unsettled.length > 0 ? { unsettled: fields.unsettled } : {}),
    ...(fields.filtersOtherFields ? { filtersOtherFields: true } : {}),
    ...(fields.emittedByAws ? { emittedByAws: true } : {}),
  };
}

/**
 * The pattern as one channel of the rule sees it. A rule listing two
 * detail-types has a summary per detail-type, and each one matches only
 * its own.
 */
function channelPattern(
  fields: EventPatternFields,
  channel: { detailType?: string },
): EventPatternMetadata {
  const whole = patternMetadata(fields);
  return channel.detailType === undefined
    ? whole
    : { ...whole, detailTypes: [channel.detailType] };
}

/** One rule, whether an AWS::Events::Rule or a SAM EventBridgeRule event. */
interface RuleRouting {
  // The rule's logical id, or the SAM event name.
  label: string;
  // The resource whose line the rule's summaries point at.
  declaredAt: string;
  eventBus: string;
  // Null when the rule declares no EventPattern.
  pattern: EventPatternFields | null;
  // Whether the rule is deployed enabled, when the template says.
  enabled?: boolean;
}

/** One channel a rule routes, with its detail-type when the pattern lists one. */
interface RuleChannel {
  channel: string;
  detailType?: string;
}

/**
 * The channels a rule routes: one per literal detail-type, or a single
 * channel whose subject is PATTERN_SUBJECT when the pattern lists none.
 */
function ruleChannels(pattern: EventPatternFields, bus: string): RuleChannel[] {
  if (pattern.detailTypes === undefined) {
    return [{ channel: formatChannel(bus, PATTERN_SUBJECT) }];
  }
  return pattern.detailTypes.map((detailType) => ({
    channel: formatChannel(bus, detailType),
    detailType,
  }));
}

function patternResolutionOf(
  pattern: EventPatternFields | null,
): "exact" | "pattern" | "unresolvable" {
  if (pattern === null) {
    return "unresolvable";
  }
  if (pattern.detailTypes === undefined) {
    return "pattern";
  }

  return "exact";
}

interface RuleTarget {
  lambdaId: string;
  lambdaResource: CloudFormationResource;
}

interface EventBridgeConsumerOpts extends Declared {
  lambdaId: string;
  lambdaResource: CloudFormationResource;
  // The rule's logical id, or the SAM event name.
  ruleLabel: string;
  channel: string;
  patternResolution: "exact" | "pattern" | "schedule" | "unresolvable";
  eventBus: string;
  // Whether the rule is deployed enabled, when the template says.
  enabled?: boolean;
  detailType?: string;
  eventPattern?: EventPatternMetadata;
  unresolvableReason?: string;
}

function buildEventBridgeSummaries(
  resources: Record<string, CloudFormationResource>,
  place: TemplatePlace,
  recognition: string,
): BehavioralSummary[] {
  const summaries: BehavioralSummary[] = [];
  // Two rules can route the same bus and detail type. One provider per
  // channel and pattern is enough, since the checker matches a send
  // against each pattern once.
  const emittedProviders = new Set<string>();

  function emitProvider(
    rule: RuleRouting,
    channel: RuleChannel,
    eventPattern: EventPatternMetadata,
  ): void {
    const key = `${channel.channel}\0${JSON.stringify(eventPattern)}`;
    if (channel.detailType === undefined || emittedProviders.has(key)) {
      return;
    }
    emittedProviders.add(key);
    summaries.push(
      buildRuleProviderSummary({
        channel: channel.channel,
        eventBus: rule.eventBus,
        detailType: channel.detailType,
        ruleLabel: rule.label,
        eventPattern,
        declaredAt: rule.declaredAt,
        place,
        recognition,
      }),
    );
  }

  // 1. AWS::Events::Rule resources.
  for (const [ruleId, resource] of Object.entries(resources)) {
    if (resource.Type !== "AWS::Events::Rule") {
      continue;
    }
    const rawTargets = resource.Properties?.Targets;
    if (!Array.isArray(rawTargets) || rawTargets.length === 0) {
      continue;
    }
    const targets = readRuleTargets(ruleId, rawTargets, resources);
    const eventBus = resolveEventBusToken(resource.Properties?.EventBusName);
    summaries.push(
      ...targets.deadLetters.map((wire) =>
        wireSummary(wire, place, recognition),
      ),
    );
    const scheduleExpr = resource.Properties?.ScheduleExpression;
    if (typeof scheduleExpr === "string" && scheduleExpr.length > 0) {
      for (const target of targets.lambdas) {
        summaries.push(
          buildEventBridgeConsumerSummary({
            lambdaId: target.lambdaId,
            lambdaResource: target.lambdaResource,
            ruleLabel: ruleId,
            channel: `schedule:${ruleId}`,
            patternResolution: "schedule",
            eventBus,
            declaredAt: ruleId,
            place,
            recognition,
            ...ruleEnablement(resource.Properties?.State),
          }),
        );
      }
      continue;
    }
    emitRuleSummaries({
      rule: {
        label: ruleId,
        declaredAt: ruleId,
        eventBus,
        pattern: readEventPattern(resource.Properties?.EventPattern),
        ...ruleEnablement(resource.Properties?.State),
      },
      targets,
      place,
      recognition,
      emitProvider,
      out: summaries,
    });
  }

  // 2. SAM EventBridgeRule and Schedule events, which target their own
  //    function.
  for (const [lambdaId, resource] of Object.entries(resources)) {
    if (resource.Type !== "AWS::Serverless::Function") {
      continue;
    }
    const events = resource.Properties?.Events;
    if (events === null || typeof events !== "object") {
      continue;
    }
    for (const [eventName, eventDefRaw] of Object.entries(
      events as Record<string, unknown>,
    )) {
      if (eventDefRaw === null || typeof eventDefRaw !== "object") {
        continue;
      }
      const eventDef = eventDefRaw as {
        Type?: unknown;
        Properties?: Record<string, unknown>;
      };
      if (eventDef.Type === "Schedule" || eventDef.Type === "ScheduleV2") {
        summaries.push(
          buildEventBridgeConsumerSummary({
            lambdaId,
            lambdaResource: resource,
            ruleLabel: eventName,
            channel: `schedule:${lambdaId}.${eventName}`,
            patternResolution: "schedule",
            eventBus: "default",
            declaredAt: lambdaId,
            place,
            recognition,
            ...(typeof eventDef.Properties?.Enabled === "boolean"
              ? { enabled: eventDef.Properties.Enabled }
              : {}),
          }),
        );
        continue;
      }
      if (eventDef.Type !== "EventBridgeRule") {
        continue;
      }
      emitRuleSummaries({
        rule: {
          label: eventName,
          declaredAt: lambdaId,
          eventBus: resolveEventBusToken(eventDef.Properties?.EventBusName),
          pattern: readEventPattern(eventDef.Properties?.Pattern),
          ...ruleEnablement(eventDef.Properties?.State),
        },
        targets: {
          lambdas: [{ lambdaId, lambdaResource: resource }],
          others: [],
          deadLetters: [],
        },
        place,
        recognition,
        emitProvider,
        out: summaries,
      });
    }
  }

  return summaries;
}

interface EmitRuleOpts {
  rule: RuleRouting;
  targets: RuleTargets;
  place: TemplatePlace;
  recognition: string;
  emitProvider: (
    rule: RuleRouting,
    channel: RuleChannel,
    eventPattern: EventPatternMetadata,
  ) => void;
  out: BehavioralSummary[];
}

function emitRuleSummaries(opts: EmitRuleOpts): void {
  const { rule, targets, place, recognition } = opts;
  if (rule.pattern === null) {
    for (const target of targets.lambdas) {
      opts.out.push(
        buildEventBridgeConsumerSummary({
          lambdaId: target.lambdaId,
          lambdaResource: target.lambdaResource,
          ruleLabel: rule.label,
          channel: formatChannel(rule.eventBus, PATTERN_SUBJECT),
          patternResolution: "unresolvable",
          eventBus: rule.eventBus,
          declaredAt: rule.declaredAt,
          place,
          recognition,
          unresolvableReason: "the rule declares no EventPattern",
          ...(rule.enabled !== undefined ? { enabled: rule.enabled } : {}),
        }),
      );
    }
    return;
  }
  const resolution = patternResolutionOf(rule.pattern);
  for (const channel of ruleChannels(rule.pattern, rule.eventBus)) {
    const eventPattern = channelPattern(rule.pattern, channel);
    opts.emitProvider(rule, channel, eventPattern);
    for (const target of targets.lambdas) {
      opts.out.push(
        buildEventBridgeConsumerSummary({
          lambdaId: target.lambdaId,
          lambdaResource: target.lambdaResource,
          ruleLabel: rule.label,
          channel: channel.channel,
          patternResolution: resolution,
          eventBus: rule.eventBus,
          declaredAt: rule.declaredAt,
          place,
          recognition,
          eventPattern,
          ...(channel.detailType !== undefined
            ? { detailType: channel.detailType }
            : {}),
          ...(rule.enabled !== undefined ? { enabled: rule.enabled } : {}),
        }),
      );
    }
    for (const target of targets.others) {
      opts.out.push(
        wireSummary(
          ruleTargetWire(rule, channel, target, eventPattern),
          place,
          recognition,
        ),
      );
    }
  }
}

/**
 * A target that is not a function takes the rule's events off the bus
 * and delivers them to a queue, a topic, another bus, or a service suss
 * does not read, such as a state machine. Either way the rule's channel
 * has a receiver.
 */
function ruleTargetWire(
  rule: RuleRouting,
  channel: RuleChannel,
  target: OtherRuleTarget,
  eventPattern: EventPatternMetadata,
): Wire {
  const suffix =
    channel.detailType === undefined ? "" : `#${channel.detailType}`;
  return {
    name: `${rule.label}.${target.id}${suffix}`,
    declaredAt: rule.declaredAt,
    wiring: "ruleTarget",
    from: { messageBus: "eventbridge", channel: channel.channel },
    to: targetDelivery(target, channel, eventPattern),
    metadata: {
      rule: rule.label,
      eventBus: rule.eventBus,
      patternResolution: patternResolutionOf(rule.pattern),
      eventPattern,
      ...(channel.detailType !== undefined
        ? { detailType: channel.detailType }
        : {}),
      ...(rule.enabled !== undefined ? { enabled: rule.enabled } : {}),
    },
  };
}

/**
 * An event forwarded to another bus keeps its detail-type and source, so
 * a forward is a send on that bus only when the pattern says which
 * detail-type it carries.
 */
function targetDelivery(
  target: OtherRuleTarget,
  channel: RuleChannel,
  eventPattern: EventPatternMetadata,
): WireTarget | null {
  if (target.delivers !== null) {
    return target.delivers;
  }
  if (target.forwardsToBus === null || channel.detailType === undefined) {
    return null;
  }
  const sources = eventPattern.sources ?? [];
  return {
    messageBus: "eventbridge",
    channel: formatChannel(target.forwardsToBus, channel.detailType),
    ...(sources.length === 1 ? { routingKey: sources[0] } : {}),
  };
}

function buildRuleProviderSummary(opts: {
  channel: string;
  eventBus: string;
  detailType: string;
  ruleLabel: string;
  eventPattern: EventPatternMetadata;
  declaredAt: string;
  place: TemplatePlace;
  recognition: string;
}): BehavioralSummary {
  return {
    kind: "library",
    location: locationOf(opts.place, opts.declaredAt),
    identity: {
      name: opts.channel,
      exportPath: null,
      boundaryBinding: messageBusBinding({
        recognition: opts.recognition,
        messageBus: "eventbridge",
        channel: opts.channel,
      }),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: withMessageBusMetadata(undefined, {
      eventBus: opts.eventBus,
      detailType: opts.detailType,
      rule: opts.ruleLabel,
      eventPattern: opts.eventPattern,
    }),
  };
}

function buildEventBridgeConsumerSummary(
  opts: EventBridgeConsumerOpts,
): BehavioralSummary {
  const codeScope = readCodeScope(opts.lambdaResource);
  const nameSuffix =
    opts.detailType !== undefined
      ? `#${opts.detailType}`
      : `.${opts.ruleLabel}`;
  return {
    kind: "consumer",
    location: locationOf(opts.place, opts.declaredAt),
    identity: {
      name: `${opts.lambdaId}${nameSuffix}`,
      exportPath: null,
      boundaryBinding: messageBusBinding({
        recognition: opts.recognition,
        messageBus: "eventbridge",
        channel: opts.channel,
      }),
      deployableUnit: {
        deploymentTarget: "lambda",
        instanceName: opts.lambdaId,
      },
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: withMessageBusMetadata(
      { codeScope },
      {
        rule: opts.ruleLabel,
        eventBus: opts.eventBus,
        patternResolution: opts.patternResolution,
        ...(opts.enabled !== undefined ? { enabled: opts.enabled } : {}),
        ...(opts.detailType !== undefined
          ? { detailType: opts.detailType }
          : {}),
        ...(opts.eventPattern !== undefined
          ? { eventPattern: opts.eventPattern }
          : {}),
        ...(opts.unresolvableReason !== undefined
          ? { unresolvableReason: opts.unresolvableReason }
          : {}),
      },
    ),
  };
}

// A DISABLED rule invokes nothing until someone turns it on, so its
// consumer is wired but idle. Any other State leaves `enabled` unset.
function ruleEnablement(state: unknown): { enabled?: boolean } {
  if (state === "ENABLED") {
    return { enabled: true };
  }
  if (state === "DISABLED") {
    return { enabled: false };
  }

  return {};
}

/** A target that is not a declared function. */
interface OtherRuleTarget {
  // The target's Id, or its position when it has none.
  id: string;
  // A declared queue or topic the target delivers to.
  delivers: WireTarget | null;
  // A declared event bus the target forwards to.
  forwardsToBus: string | null;
}

interface RuleTargets {
  lambdas: RuleTarget[];
  others: OtherRuleTarget[];
  // A target's DeadLetterConfig queue, which gets what the rule could
  // not deliver.
  deadLetters: Wire[];
}

function readRuleTargets(
  ruleId: string,
  targets: unknown[],
  resources: Record<string, CloudFormationResource>,
): RuleTargets {
  const read: RuleTargets = { lambdas: [], others: [], deadLetters: [] };
  for (const [index, target] of targets.entries()) {
    if (target === null || typeof target !== "object") {
      continue;
    }
    const record = target as Record<string, unknown>;
    if (record.Arn === undefined) {
      continue;
    }
    const id = typeof record.Id === "string" ? record.Id : `Target${index}`;
    const deadLetter = channelTargetOf(
      (record.DeadLetterConfig as { Arn?: unknown } | undefined)?.Arn,
      resources,
    );
    if (deadLetter !== null) {
      read.deadLetters.push({
        name: `${ruleId}.${id}.DeadLetterConfig`,
        declaredAt: ruleId,
        wiring: "deadLetter",
        from: null,
        to: deadLetter,
      });
    }
    const lambdaId = refTarget(record.Arn);
    const lambdaResource = lambdaId === null ? undefined : resources[lambdaId];
    if (
      lambdaId !== null &&
      lambdaResource !== undefined &&
      isFunction(lambdaResource)
    ) {
      read.lambdas.push({ lambdaId, lambdaResource });
      continue;
    }
    read.others.push({
      id,
      delivers: channelTargetOf(record.Arn, resources),
      forwardsToBus: eventBusTargetOf(record.Arn, resources),
    });
  }
  return read;
}

// ---------------------------------------------------------------------------
// SNS
// ---------------------------------------------------------------------------

// A standalone AWS::SNS::Subscription, or an entry inline on its topic.
interface SnsSubscription {
  // The topic's logical id, which is also its channel.
  topicId: string;
  // The standalone resource's logical id, or a made-up label for an
  // inline entry, which has none.
  label: string;
  // The resource that declares the subscription.
  declaredAt: string;
  protocol: string;
  endpoint: unknown;
  filterPolicy: unknown;
}

// Standalone subscriptions and entries inline on a topic's `Subscription`
// list. CloudFormation's inline entry has only Protocol and Endpoint.
function collectSnsSubscriptions(
  resources: Record<string, CloudFormationResource>,
): SnsSubscription[] {
  const out: SnsSubscription[] = [];

  for (const [subId, resource] of Object.entries(resources)) {
    if (resource.Type !== "AWS::SNS::Subscription") {
      continue;
    }
    const protocol = resource.Properties?.Protocol;
    if (typeof protocol !== "string") {
      continue;
    }
    const topicId = resolveTopicChannel(resource.Properties?.TopicArn);
    if (topicId === null) {
      continue;
    }
    out.push({
      topicId,
      label: subId,
      declaredAt: subId,
      protocol,
      endpoint: resource.Properties?.Endpoint,
      filterPolicy: resource.Properties?.FilterPolicy,
    });
  }

  for (const [topicId, resource] of Object.entries(resources)) {
    if (resource.Type !== "AWS::SNS::Topic") {
      continue;
    }
    const inline = resource.Properties?.Subscription;
    if (!Array.isArray(inline)) {
      continue;
    }
    for (const [index, entry] of inline.entries()) {
      if (entry === null || typeof entry !== "object") {
        continue;
      }
      const protocol = (entry as { Protocol?: unknown }).Protocol;
      if (typeof protocol !== "string") {
        continue;
      }
      out.push({
        topicId,
        label: `${topicId}.Subscription${index}`,
        declaredAt: topicId,
        protocol,
        endpoint: (entry as { Endpoint?: unknown }).Endpoint,
        // Only the standalone resource can have a FilterPolicy.
        filterPolicy: undefined,
      });
    }
  }

  return out;
}

interface SnsLambdaConsumerOpts extends Declared {
  lambdaId: string;
  lambdaResource: CloudFormationResource;
  // The subscription's label, or the SAM event name.
  label: string;
  topicId: string;
  filterPolicy: unknown;
  // A SAM event's SqsSubscription, which puts a queue between the topic
  // and the function (#154).
  sqsSubscription?: unknown;
}

// `true` makes SAM create a queue that exists only once deployed, and the
// map form points at a declared queue. Either way the function reads from
// a queue, and the summary records it.
function sqsDeliveryOf(
  sqsSubscription: unknown,
): { deliveredThrough: "aws_sqs"; queue: string } | null {
  if (sqsSubscription === undefined || sqsSubscription === false) {
    return null;
  }
  if (sqsSubscription === true) {
    return { deliveredThrough: "aws_sqs", queue: "<sam-managed>" };
  }
  const record = sqsSubscription as Record<string, unknown>;
  const queue = refTarget(record.QueueArn ?? record.QueueUrl);
  return { deliveredThrough: "aws_sqs", queue: queue ?? "<unresolved>" };
}

// SNS has no subject per message to name a consumer by, so the name uses
// the subscription's label, as an SQS consumer uses its event name.
function buildSnsLambdaConsumerSummary(
  opts: SnsLambdaConsumerOpts,
): BehavioralSummary {
  const codeScope = readCodeScope(opts.lambdaResource);
  const resolution = reduceFilterPolicy(opts.filterPolicy);
  const delivery = sqsDeliveryOf(opts.sqsSubscription);
  return {
    kind: "consumer",
    location: locationOf(opts.place, opts.declaredAt),
    identity: {
      name: `${opts.lambdaId}.${opts.label}`,
      exportPath: null,
      boundaryBinding: messageBusBinding({
        recognition: opts.recognition,
        messageBus: "aws.sns",
        channel: opts.topicId,
      }),
      deployableUnit: {
        deploymentTarget: "lambda",
        instanceName: opts.lambdaId,
      },
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: withMessageBusMetadata(
      { codeScope },
      {
        subscription: opts.label,
        patternResolution: resolution.kind,
        ...(resolution.kind === "unresolvable"
          ? { unresolvableReason: resolution.reason }
          : {}),
        ...(delivery ?? {}),
      },
    ),
  };
}

type FilterPolicyResolution =
  | { kind: "exact" }
  | { kind: "unresolvable"; reason: string };

// With no FilterPolicy the subscription gets every message. Filters are
// not reduced yet, so one that is present is reported as unresolvable.
function reduceFilterPolicy(filterPolicy: unknown): FilterPolicyResolution {
  if (filterPolicy === undefined) {
    return { kind: "exact" };
  }
  return {
    kind: "unresolvable",
    reason:
      "the subscription declares a FilterPolicy, and suss pairs a subscription only on its whole topic",
  };
}

// ---------------------------------------------------------------------------
// S3
// ---------------------------------------------------------------------------

interface S3LambdaNotification {
  bucketId: string;
  label: string;
  functionRef: unknown;
  event: unknown;
  filter: unknown;
}

interface S3QueueNotification {
  bucketId: string;
  queueRef: unknown;
  filter: unknown;
}

// S3 notifications are inline on the bucket and have no logical id, so
// each label is made from the bucket, kind and position. A queue or
// topic notification is a wire, so only its bucket and routing are read.
function collectS3Notifications(
  resources: Record<string, CloudFormationResource>,
): {
  lambda: S3LambdaNotification[];
  queue: S3QueueNotification[];
  topic: Array<{ bucketId: string }>;
} {
  const lambda: S3LambdaNotification[] = [];
  const queue: S3QueueNotification[] = [];
  const topic: Array<{ bucketId: string }> = [];

  for (const [bucketId, resource] of Object.entries(resources)) {
    if (resource.Type !== "AWS::S3::Bucket") {
      continue;
    }
    const notificationConfig = resource.Properties?.NotificationConfiguration;
    if (notificationConfig === null || typeof notificationConfig !== "object") {
      continue;
    }
    const config = notificationConfig as Record<string, unknown>;

    for (const [index, e] of objectEntries(config.LambdaConfigurations)) {
      lambda.push({
        bucketId,
        label: `${bucketId}.LambdaConfiguration${index}`,
        functionRef: e.Function,
        event: e.Event,
        filter: e.Filter,
      });
    }
    for (const [, e] of objectEntries(config.QueueConfigurations)) {
      queue.push({ bucketId, queueRef: e.Queue, filter: e.Filter });
    }
    if (objectEntries(config.TopicConfigurations).length > 0) {
      topic.push({ bucketId });
    }
  }

  return { lambda, queue, topic };
}

/** The entries of a list that are objects, each with its position. */
function objectEntries(
  value: unknown,
): Array<[number, Record<string, unknown>]> {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...value.entries()].filter(
    (entry): entry is [number, Record<string, unknown>] =>
      entry[1] !== null && typeof entry[1] === "object",
  );
}

function buildBucketProviderSummary(
  logicalId: string,
  resource: CloudFormationResource,
  place: TemplatePlace,
  recognition: string,
): BehavioralSummary {
  return {
    kind: "library",
    location: locationOf(place, logicalId),
    identity: {
      name: logicalId,
      exportPath: null,
      boundaryBinding: messageBusBinding({
        recognition,
        messageBus: "s3",
        channel: logicalId,
      }),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: withMessageBusMetadata(undefined, {
      ...(typeof resource.Properties?.BucketName === "string"
        ? { physicalName: resource.Properties.BucketName }
        : {}),
    }),
  };
}

interface S3LambdaConsumerOpts extends Declared {
  lambdaId: string;
  lambdaResource: CloudFormationResource;
  // The LambdaConfiguration's label, or the SAM event name.
  label: string;
  bucketId: string;
  event: unknown;
  filter: unknown;
}

function buildS3LambdaConsumerSummary(
  opts: S3LambdaConsumerOpts,
): BehavioralSummary {
  const codeScope = readCodeScope(opts.lambdaResource);
  const resolution = reduceS3Filter(opts.filter);
  const events = eventList(opts.event);
  return {
    kind: "consumer",
    location: locationOf(opts.place, opts.declaredAt),
    identity: {
      name: `${opts.lambdaId}.${opts.label}`,
      exportPath: null,
      boundaryBinding: messageBusBinding({
        recognition: opts.recognition,
        messageBus: "s3",
        channel: opts.bucketId,
      }),
      deployableUnit: {
        deploymentTarget: "lambda",
        instanceName: opts.lambdaId,
      },
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: withMessageBusMetadata(
      { codeScope },
      {
        notification: opts.label,
        ...(events !== undefined ? { events } : {}),
        patternResolution: resolution.kind,
        ...(resolution.kind === "unresolvable"
          ? { unresolvableReason: resolution.reason }
          : {}),
      },
    ),
  };
}

// The same rule as reduceFilterPolicy, for S3Key prefix and suffix filters.
function reduceS3Filter(filter: unknown): FilterPolicyResolution {
  if (filter === undefined) {
    return { kind: "exact" };
  }
  return {
    kind: "unresolvable",
    reason:
      "the notification declares a Filter, and suss pairs a notification only on its whole bucket",
  };
}

// A notification's `Event` is one string, and SAM's S3 `Events` can be a
// string or a list.
function eventList(value: unknown): string[] | undefined {
  if (typeof value === "string") {
    return [value];
  }
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === "string")
  ) {
    return value;
  }
  return undefined;
}
