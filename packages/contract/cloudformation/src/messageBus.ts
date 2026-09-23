/**
 * Provider and consumer summaries for SQS queues, SNS topics,
 * EventBridge rules and S3 bucket notifications. The README describes
 * the channel each family uses.
 *
 * A provider summary (kind library) says a channel exists, and producers
 * in code pair with it. A consumer summary (kind consumer) says a Lambda
 * receives from a channel, and has the same channel as the provider.
 *
 * A queue's consumers take the channel of the single subject routed into
 * the queue, when there is one, so a producer upstream pairs with the
 * Lambda that ends up handling its message.
 */

import { messageBusBinding, withMessageBusMetadata } from "@suss/behavioral-ir";
import { formatChannel } from "@suss/ir-core";
import {
  type PatternReduction,
  reduceEventPattern,
  refTarget,
  resolveBucketChannel,
  resolveEventBusToken,
  resolveQueueChannel,
  resolveTopicChannel,
} from "@suss/manifest-aws";

import { readCodeScope } from "./runtimeConfig.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

interface CloudFormationResource {
  Type?: string;
  Properties?: Record<string, unknown>;
  Metadata?: Record<string, unknown>;
}

/**
 * Every message-bus provider and consumer summary in the template.
 * Producers are not emitted here; the aws-sqs, aws-sns and
 * aws-eventbridge packs find them in code.
 *
 * A consumer's `metadata.codeScope` matches its function's runtime-config
 * summary, so code reads can be scoped to the consumer. When a queue's
 * consumer takes an upstream subject's channel, the queue's logical id
 * moves to `metadata.messageBus.queue`, so accounting per queue still
 * sees the consumer.
 */
export function buildMessageBusSummaries(
  resources: Record<string, CloudFormationResource>,
  sourceFile: string,
  recognition = "cloudformation",
): BehavioralSummary[] {
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
      buildQueueProviderSummary(logicalId, resource, sourceFile, recognition),
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
            sourceFile,
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
            sourceFile,
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
            sourceFile,
            recognition,
          }),
        );
      }
    }
  }

  // 3. Consumers from an EventSourceMapping, which plain CloudFormation
  //    declares where SAM would use an SQS event.
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
        routed: singleRoutedSubjectOf(queueSubjects, channel),
        sourceFile,
        recognition,
      }),
    );
  }

  // 4. EventBridge rules and SAM EventBridgeRule and Schedule events.
  summaries.push(
    ...buildEventBridgeSummaries(resources, sourceFile, recognition),
  );

  // 5. SNS topics, and a consumer per "lambda" subscription. An "sqs"
  //    subscription was already counted in queueSubjects, and other
  //    protocols do not reach code.
  for (const [logicalId, resource] of Object.entries(resources)) {
    if (resource.Type !== "AWS::SNS::Topic") {
      continue;
    }
    summaries.push(
      buildTopicProviderSummary(logicalId, resource, sourceFile, recognition),
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
    if (
      lambdaResource === undefined ||
      (lambdaResource.Type !== "AWS::Serverless::Function" &&
        lambdaResource.Type !== "AWS::Lambda::Function")
    ) {
      continue;
    }
    summaries.push(
      buildSnsLambdaConsumerSummary({
        lambdaId,
        lambdaResource,
        label: sub.label,
        topicId: sub.topicId,
        filterPolicy: sub.filterPolicy,
        sourceFile,
        recognition,
      }),
    );
  }

  // 6. Buckets with a notification, and their Lambda and topic consumers.
  //    A QueueConfiguration was already counted in queueSubjects.
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
        sourceFile,
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
    if (
      lambdaResource === undefined ||
      (lambdaResource.Type !== "AWS::Serverless::Function" &&
        lambdaResource.Type !== "AWS::Lambda::Function")
    ) {
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
        sourceFile,
        recognition,
      }),
    );
  }
  for (const notification of s3Notifications.topic) {
    const consumer = buildS3TopicBridgeConsumerSummary(
      notification,
      resources,
      sourceFile,
      recognition,
    );
    if (consumer !== null) {
      summaries.push(consumer);
    }
  }

  return summaries;
}

function buildQueueProviderSummary(
  logicalId: string,
  resource: CloudFormationResource,
  sourceFile: string,
  recognition: string,
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
  sourceFile: string,
  recognition: string,
): BehavioralSummary {
  const fifoTopic = resource.Properties?.FifoTopic === true;
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

interface LambdaConsumerOpts {
  lambdaId: string;
  lambdaResource: CloudFormationResource;
  eventName: string;
  // The queue's logical id.
  channel: string;
  // Null when no subject, or more than one, is routed into the queue.
  routed: RoutedSubject | null;
  sourceFile: string;
  recognition: string;
}

function buildLambdaConsumerSummary(
  opts: LambdaConsumerOpts,
): BehavioralSummary {
  const codeScope = readCodeScope(opts.lambdaResource);
  return {
    kind: "consumer",
    location: {
      file: opts.sourceFile,
      range: { start: 1, end: 1 },
      exportName: null,
    },
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
            }
          : {}),
      },
    ),
  };
}

// A subject routed into a queue from an EventBridge rule, an SNS topic or
// an S3 bucket. `eventBus` and `detailType` are only set for a rule.
interface RoutedSubject {
  // `<bus>#<detailType>` for a rule, or the topic's or bucket's logical id.
  channel: string;
  eventBus?: string;
  detailType?: string;
}

// The subjects routed into each queue, keyed by channel so one subject
// routed twice counts once. A rule's DeadLetterConfig queue gets failed
// deliveries only, so only a target's own `Arn` counts.
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
    const reduction = reduceEventPattern(resource.Properties?.EventPattern);
    if (reduction.kind !== "exact") {
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
      for (const detailType of reduction.detailTypes) {
        const channel = formatChannel(eventBus, detailType);
        routed.set(channel, { channel, eventBus, detailType });
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

interface RuleTarget {
  lambdaId: string;
  lambdaResource: CloudFormationResource;
}

interface EventBridgeConsumerOpts {
  lambdaId: string;
  lambdaResource: CloudFormationResource;
  // The rule's logical id, or the SAM event name.
  ruleLabel: string;
  channel: string;
  patternResolution: "exact" | "schedule" | "unresolvable";
  eventBus: string;
  sourceFile: string;
  recognition: string;
  // Whether the rule is deployed enabled, when the template says.
  enabled?: boolean;
  detailType?: string;
  unresolvableReason?: string;
}

function buildEventBridgeSummaries(
  resources: Record<string, CloudFormationResource>,
  sourceFile: string,
  recognition: string,
): BehavioralSummary[] {
  const summaries: BehavioralSummary[] = [];
  // Two rules can route the same bus and detail type, and the checker
  // pairs by channel, so one provider per channel is enough.
  const emittedProviderChannels = new Set<string>();

  function emitProvider(
    channel: string,
    eventBus: string,
    detailType: string,
    ruleLabel: string,
  ): void {
    if (emittedProviderChannels.has(channel)) {
      return;
    }
    emittedProviderChannels.add(channel);
    summaries.push(
      buildRuleProviderSummary({
        channel,
        eventBus,
        detailType,
        ruleLabel,
        sourceFile,
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
    // A rule that only targets a queue has no Lambda consumer, but it
    // still gets a provider so the producer is not reported as an orphan.
    const targets = readRuleTargets(rawTargets, resources);
    const eventBus = resolveEventBusToken(resource.Properties?.EventBusName);
    const scheduleExpr = resource.Properties?.ScheduleExpression;
    if (typeof scheduleExpr === "string" && scheduleExpr.length > 0) {
      for (const target of targets) {
        summaries.push(
          buildEventBridgeConsumerSummary({
            lambdaId: target.lambdaId,
            lambdaResource: target.lambdaResource,
            ruleLabel: ruleId,
            channel: `schedule:${ruleId}`,
            patternResolution: "schedule",
            eventBus,
            sourceFile,
            recognition,
            ...ruleEnablement(resource.Properties?.State),
          }),
        );
      }
      continue;
    }
    const reduction = reduceEventPattern(resource.Properties?.EventPattern);
    emitRuleSummaries({
      reduction,
      eventBus,
      ruleLabel: ruleId,
      targets,
      sourceFile,
      recognition,
      emitProvider,
      out: summaries,
      ...ruleEnablement(resource.Properties?.State),
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
      const target: RuleTarget = { lambdaId, lambdaResource: resource };
      if (eventDef.Type === "Schedule" || eventDef.Type === "ScheduleV2") {
        summaries.push(
          buildEventBridgeConsumerSummary({
            lambdaId,
            lambdaResource: resource,
            ruleLabel: eventName,
            channel: `schedule:${lambdaId}.${eventName}`,
            patternResolution: "schedule",
            eventBus: "default",
            sourceFile,
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
      const eventBus = resolveEventBusToken(eventDef.Properties?.EventBusName);
      const reduction = reduceEventPattern(eventDef.Properties?.Pattern);
      emitRuleSummaries({
        reduction,
        eventBus,
        ruleLabel: eventName,
        targets: [target],
        sourceFile,
        recognition,
        emitProvider,
        out: summaries,
        ...ruleEnablement(eventDef.Properties?.State),
      });
    }
  }

  return summaries;
}

interface EmitRuleOpts {
  reduction: PatternReduction;
  eventBus: string;
  ruleLabel: string;
  targets: RuleTarget[];
  sourceFile: string;
  recognition: string;
  // From the rule's State, when it is set (#207).
  enabled?: boolean;
  emitProvider: (
    channel: string,
    eventBus: string,
    detailType: string,
    ruleLabel: string,
  ) => void;
  out: BehavioralSummary[];
}

function emitRuleSummaries(opts: EmitRuleOpts): void {
  if (opts.reduction.kind === "unresolvable") {
    for (const target of opts.targets) {
      opts.out.push(
        buildEventBridgeConsumerSummary({
          lambdaId: target.lambdaId,
          lambdaResource: target.lambdaResource,
          ruleLabel: opts.ruleLabel,
          channel: `${opts.eventBus}#<unresolved>`,
          patternResolution: "unresolvable",
          eventBus: opts.eventBus,
          sourceFile: opts.sourceFile,
          recognition: opts.recognition,
          unresolvableReason: opts.reduction.reason,
          ...(opts.enabled !== undefined ? { enabled: opts.enabled } : {}),
        }),
      );
    }
    return;
  }
  for (const detailType of opts.reduction.detailTypes) {
    const channel = formatChannel(opts.eventBus, detailType);
    opts.emitProvider(channel, opts.eventBus, detailType, opts.ruleLabel);
    for (const target of opts.targets) {
      opts.out.push(
        buildEventBridgeConsumerSummary({
          lambdaId: target.lambdaId,
          lambdaResource: target.lambdaResource,
          ruleLabel: opts.ruleLabel,
          channel,
          patternResolution: "exact",
          eventBus: opts.eventBus,
          detailType,
          sourceFile: opts.sourceFile,
          recognition: opts.recognition,
          ...(opts.enabled !== undefined ? { enabled: opts.enabled } : {}),
        }),
      );
    }
  }
}

function buildRuleProviderSummary(opts: {
  channel: string;
  eventBus: string;
  detailType: string;
  ruleLabel: string;
  sourceFile: string;
  recognition: string;
}): BehavioralSummary {
  return {
    kind: "library",
    location: {
      file: opts.sourceFile,
      range: { start: 1, end: 1 },
      exportName: null,
    },
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
    location: {
      file: opts.sourceFile,
      range: { start: 1, end: 1 },
      exportName: null,
    },
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

// Only Lambda targets. A queue target is handled by buildQueueSubjectMap,
// and other targets are skipped.
function readRuleTargets(
  targets: unknown,
  resources: Record<string, CloudFormationResource>,
): RuleTarget[] {
  if (!Array.isArray(targets)) {
    return [];
  }
  const out: RuleTarget[] = [];
  for (const target of targets) {
    if (target === null || typeof target !== "object") {
      continue;
    }
    const arn = (target as { Arn?: unknown }).Arn;
    const lambdaId = refTarget(arn);
    if (lambdaId === null) {
      continue;
    }
    const lambdaResource = resources[lambdaId];
    if (lambdaResource === undefined) {
      continue;
    }
    if (
      lambdaResource.Type !== "AWS::Serverless::Function" &&
      lambdaResource.Type !== "AWS::Lambda::Function"
    ) {
      continue;
    }
    out.push({ lambdaId, lambdaResource });
  }
  return out;
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
        protocol,
        endpoint: (entry as { Endpoint?: unknown }).Endpoint,
        // Only the standalone resource can have a FilterPolicy.
        filterPolicy: undefined,
      });
    }
  }

  return out;
}

interface SnsLambdaConsumerOpts {
  lambdaId: string;
  lambdaResource: CloudFormationResource;
  // The subscription's label, or the SAM event name.
  label: string;
  topicId: string;
  filterPolicy: unknown;
  // A SAM event's SqsSubscription, which puts a queue between the topic
  // and the function (#154).
  sqsSubscription?: unknown;
  sourceFile: string;
  recognition: string;
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
    location: {
      file: opts.sourceFile,
      range: { start: 1, end: 1 },
      exportName: null,
    },
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
      "subscription declares a FilterPolicy; v0 pairs on the whole topic only, filter-policy reduction is out of scope",
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
  label: string;
  queueRef: unknown;
  event: unknown;
  filter: unknown;
}

interface S3TopicNotification {
  bucketId: string;
  label: string;
  topicRef: unknown;
  event: unknown;
  filter: unknown;
}

// S3 notifications are always inline on the bucket and have no logical id
// of their own, so each label is made from the bucket, kind and position.
function collectS3Notifications(
  resources: Record<string, CloudFormationResource>,
): {
  lambda: S3LambdaNotification[];
  queue: S3QueueNotification[];
  topic: S3TopicNotification[];
} {
  const lambda: S3LambdaNotification[] = [];
  const queue: S3QueueNotification[] = [];
  const topic: S3TopicNotification[] = [];

  for (const [bucketId, resource] of Object.entries(resources)) {
    if (resource.Type !== "AWS::S3::Bucket") {
      continue;
    }
    const notificationConfig = resource.Properties?.NotificationConfiguration;
    if (notificationConfig === null || typeof notificationConfig !== "object") {
      continue;
    }
    const config = notificationConfig as Record<string, unknown>;

    const lambdaConfigs = config.LambdaConfigurations;
    if (Array.isArray(lambdaConfigs)) {
      for (const [index, entry] of lambdaConfigs.entries()) {
        if (entry === null || typeof entry !== "object") {
          continue;
        }
        const e = entry as Record<string, unknown>;
        lambda.push({
          bucketId,
          label: `${bucketId}.LambdaConfiguration${index}`,
          functionRef: e.Function,
          event: e.Event,
          filter: e.Filter,
        });
      }
    }

    const queueConfigs = config.QueueConfigurations;
    if (Array.isArray(queueConfigs)) {
      for (const [index, entry] of queueConfigs.entries()) {
        if (entry === null || typeof entry !== "object") {
          continue;
        }
        const e = entry as Record<string, unknown>;
        queue.push({
          bucketId,
          label: `${bucketId}.QueueConfiguration${index}`,
          queueRef: e.Queue,
          event: e.Event,
          filter: e.Filter,
        });
      }
    }

    const topicConfigs = config.TopicConfigurations;
    if (Array.isArray(topicConfigs)) {
      for (const [index, entry] of topicConfigs.entries()) {
        if (entry === null || typeof entry !== "object") {
          continue;
        }
        const e = entry as Record<string, unknown>;
        topic.push({
          bucketId,
          label: `${bucketId}.TopicConfiguration${index}`,
          topicRef: e.Topic,
          event: e.Event,
          filter: e.Filter,
        });
      }
    }
  }

  return { lambda, queue, topic };
}

function buildBucketProviderSummary(
  logicalId: string,
  resource: CloudFormationResource,
  sourceFile: string,
  recognition: string,
): BehavioralSummary {
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

interface S3LambdaConsumerOpts {
  lambdaId: string;
  lambdaResource: CloudFormationResource;
  // The LambdaConfiguration's label, or the SAM event name.
  label: string;
  bucketId: string;
  event: unknown;
  filter: unknown;
  sourceFile: string;
  recognition: string;
}

function buildS3LambdaConsumerSummary(
  opts: S3LambdaConsumerOpts,
): BehavioralSummary {
  const codeScope = readCodeScope(opts.lambdaResource);
  const resolution = reduceS3Filter(opts.filter);
  const events = eventList(opts.event);
  return {
    kind: "consumer",
    location: {
      file: opts.sourceFile,
      range: { start: 1, end: 1 },
      exportName: null,
    },
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

// Nothing lets a source upstream of a topic change its subscribers'
// channel, as buildQueueSubjectMap does for a queue, so the bucket gets a
// consumer that records the topic. Null when the topic is not declared.
function buildS3TopicBridgeConsumerSummary(
  notification: S3TopicNotification,
  resources: Record<string, CloudFormationResource>,
  sourceFile: string,
  recognition: string,
): BehavioralSummary | null {
  const topicId = resolveTopicChannel(notification.topicRef);
  if (topicId === null || resources[topicId]?.Type !== "AWS::SNS::Topic") {
    return null;
  }
  const resolution = reduceS3Filter(notification.filter);
  const events = eventList(notification.event);
  return {
    kind: "consumer",
    location: {
      file: sourceFile,
      range: { start: 1, end: 1 },
      exportName: null,
    },
    identity: {
      name: notification.label,
      exportPath: null,
      boundaryBinding: messageBusBinding({
        recognition,
        messageBus: "s3",
        channel: notification.bucketId,
      }),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: withMessageBusMetadata(undefined, {
      notification: notification.label,
      topic: topicId,
      ...(events !== undefined ? { events } : {}),
      patternResolution: resolution.kind,
      ...(resolution.kind === "unresolvable"
        ? { unresolvableReason: resolution.reason }
        : {}),
    }),
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
      "notification declares a Filter; v0 pairs on the whole bucket only, filter reduction is out of scope",
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
