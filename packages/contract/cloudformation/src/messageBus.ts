// messageBus.ts — emit message-bus provider + consumer summaries for
// two AWS bus families:
//
//   SQS         — provider per AWS::SQS::Queue, consumer per Lambda
//                 wired via SAM Events:{Type: SQS} or an
//                 AWS::Lambda::EventSourceMapping. Channel = queue CFN
//                 logical id, except when an EventBridge rule routes
//                 exactly one subject into the queue. In that case the
//                 consumer's channel is that subject on the routing
//                 bus, `${bus}#${detailType}`, so the EventBridge
//                 producer that emits the subject pairs with the
//                 Lambda that ends up handling it. Pairs against
//                 @suss/framework-aws-sqs producer effects too.
//
//   EventBridge — provider + consumer per (bus, detailType) a rule
//                 routes, plus schedule / unresolvable-pattern
//                 accounting. Channel = `${bus}#${detailType}`. Pairs
//                 against @suss/framework-aws-eventbridge producer
//                 effects. See buildEventBridgeSummaries for the scheme.
//
// Provider summaries (kind: library) describe "this channel exists;
// messages cross it" — producers pair against them. Consumer summaries
// (kind: consumer) describe "this Lambda receives from channel X" and
// share the channel identity so the pairing dispatcher joins producers
// to consumers.

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
 *     When the template also routes the queue from an EventBridge
 *     rule with exactly one exact detail-type, the consumer's channel
 *     is `${bus}#${detailType}` instead. That is the same channel the
 *     EventBridge producer emits, so a producer that publishes the
 *     subject pairs with the Lambda that drains the queue the rule
 *     feeds. The queue's logical id moves to metadata.messageBus.queue
 *     so queue-level accounting still sees the consumer. A queue
 *     routed with several subjects (several detail-types, or the same
 *     detail-type from two buses) keeps the logical-id channel,
 *     because no one subject identifies what it carries.
 *
 * Producer effects on the consumer side are NOT emitted here — those
 * are recognized at extraction time by `@suss/framework-aws-sqs`.
 */
export function buildMessageBusSummaries(
  resources: Record<string, CloudFormationResource>,
  sourceFile: string,
): BehavioralSummary[] {
  const summaries: BehavioralSummary[] = [];
  const queueSubjects = buildQueueSubjectMap(resources);

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
          routed: singleRoutedSubjectOf(queueSubjects, channel),
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
        routed: singleRoutedSubjectOf(queueSubjects, channel),
        sourceFile,
      }),
    );
  }

  // 4. EventBridge: AWS::Events::Rule + SAM Events:{Type: EventBridgeRule
  //    | Schedule}.
  summaries.push(...buildEventBridgeSummaries(resources, sourceFile));

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
  /** CFN logical id of the queue the Lambda consumes from. */
  channel: string;
  /**
   * The one (bus, detail-type) an EventBridge rule routes into the
   * queue, or null when the queue is not rule-fed (command queues) or
   * is routed with several subjects.
   */
  routed: RoutedSubject | null;
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
    metadata: {
      codeScope,
      messageBus: {
        eventName: opts.eventName,
        ...(opts.routed !== null
          ? {
              queue: opts.channel,
              subject: opts.routed.detailType,
              eventBus: opts.routed.eventBus,
            }
          : {}),
      },
    },
  };
}

/** One (bus, detailType) an EventBridge rule routes into a queue. */
interface RoutedSubject {
  /** `${eventBus}#${detailType}`, the EventBridge channel scheme. */
  channel: string;
  eventBus: string;
  detailType: string;
}

/**
 * Map each SQS queue's CFN logical id to the set of EventBridge
 * channels rules route into it, keyed by channel so the same (bus,
 * detail-type) routed by two rules counts once. Only rules whose
 * EventPattern reduces to exact detail-types contribute; scheduled
 * rules carry no message subject and are skipped. Only a target's own
 * `Arn` counts, so a target's DeadLetterConfig queue (which receives
 * failed deliveries, not the routed subject) is left alone.
 */
function buildQueueSubjectMap(
  resources: Record<string, CloudFormationResource>,
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
    const eventBus = resolveEventBusToken(
      resource.Properties?.EventBusName,
      resources,
    );
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
        const channel = `${eventBus}#${detailType}`;
        routed.set(channel, { channel, eventBus, detailType });
      }
      map.set(queueId, routed);
    }
  }
  return map;
}

/**
 * The one channel routed into the queue, or null when rules route
 * several (or none). Only a single-channel queue can lend its consumer
 * an unambiguous subject identity.
 */
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
//
// CHANNEL SCHEME. One event bus multiplexes many event types; a rule
// subscribes to a subset keyed by DetailType. So the channel carries
// BOTH parts — `${bus}#${detailType}` — matching the producer scheme in
// @suss/framework-aws-eventbridge:
//
//   - `bus` is the event bus CFN logical id when the rule's
//     EventBusName is a Ref/GetAtt (or an EventBus ARN we can segment),
//     or "default" when EventBusName is omitted (EventBridge default
//     bus). Producers name the bus via an env var that the checker
//     chain-collapses to the same logical id.
//   - `detailType` is each literal from the rule's EventPattern
//     `detail-type` array.
//
// ROLES.
//   - Each (bus, detailType) a rule routes → one PROVIDER summary
//     (kind: library). Producers pair against it; a producer emitting a
//     detailType no rule routes surfaces as messageBusProducerOrphan.
//   - Each (rule, detailType, Lambda target) → one CONSUMER summary
//     (kind: consumer), scoped to the target Lambda's code.
//
// PATTERN REDUCTION (v0). Only literal `detail-type` arrays reduce to
// exact detail-types. A rule whose pattern can't be reduced (no
// detail-type field, content filters like `{ prefix: … }`, `anything-
// but`, etc.) still emits a consumer summary, flagged
// `metadata.messageBus.patternResolution = "unresolvable"` so the
// checker surfaces it (never silent) rather than pairing on a guessed
// channel. Pattern subsumption is out of v0 scope.
//
// SCHEDULES. A scheduled rule (ScheduleExpression, or SAM Events
// {Type: Schedule}) is time-triggered — no message, no producer. Its
// target Lambda emits a consumer summary flagged
// `patternResolution = "schedule"` so the checker accounts for it
// without flagging it as an orphaned consumer.
//
// The EventBus resource itself doesn't get a standalone provider
// summary: its identity rides inside every rule channel's `bus`
// segment, and a bare bus-level channel (no detailType) that no
// producer or consumer uses would otherwise mis-report as unused.

type PatternReduction =
  | { kind: "exact"; detailTypes: string[] }
  | { kind: "unresolvable"; reason: string };

interface RuleTarget {
  lambdaId: string;
  lambdaResource: CloudFormationResource;
}

interface EventBridgeConsumerOpts {
  lambdaId: string;
  lambdaResource: CloudFormationResource;
  /** Rule identity for the summary name (CFN logical id or SAM event name). */
  ruleLabel: string;
  channel: string;
  patternResolution: "exact" | "schedule" | "unresolvable";
  eventBus: string;
  sourceFile: string;
  detailType?: string;
  unresolvableReason?: string;
}

function buildEventBridgeSummaries(
  resources: Record<string, CloudFormationResource>,
  sourceFile: string,
): BehavioralSummary[] {
  const summaries: BehavioralSummary[] = [];
  // Dedup provider summaries by channel — two rules can route the same
  // (bus, detailType), but the checker keys pairing on the channel Set,
  // so one provider per channel is enough.
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
      }),
    );
  }

  // 1. Raw AWS::Events::Rule resources.
  for (const [ruleId, resource] of Object.entries(resources)) {
    if (resource.Type !== "AWS::Events::Rule") {
      continue;
    }
    const rawTargets = resource.Properties?.Targets;
    if (!Array.isArray(rawTargets) || rawTargets.length === 0) {
      continue;
    }
    // Lambda targets get consumer summaries. A rule routing only to a
    // queue has none, but it still declares the subject crosses the
    // bus, so its provider summary is emitted either way — otherwise
    // the producer that sends the subject reads as an orphan.
    const targets = readRuleTargets(rawTargets, resources);
    const eventBus = resolveEventBusToken(
      resource.Properties?.EventBusName,
      resources,
    );
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
      emitProvider,
      out: summaries,
    });
  }

  // 2. SAM Events:{Type: EventBridgeRule | Schedule} on Serverless
  //    Functions. The owning Lambda is the target.
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
          }),
        );
        continue;
      }
      if (eventDef.Type !== "EventBridgeRule") {
        continue;
      }
      const eventBus = resolveEventBusToken(
        eventDef.Properties?.EventBusName,
        resources,
      );
      const reduction = reduceEventPattern(eventDef.Properties?.Pattern);
      emitRuleSummaries({
        reduction,
        eventBus,
        ruleLabel: eventName,
        targets: [target],
        sourceFile,
        emitProvider,
        out: summaries,
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
          unresolvableReason: opts.reduction.reason,
        }),
      );
    }
    return;
  }
  for (const detailType of opts.reduction.detailTypes) {
    const channel = `${opts.eventBus}#${detailType}`;
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
        recognition: "cloudformation",
        messageBus: "eventbridge",
        channel: opts.channel,
      }),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: {
      messageBus: {
        eventBus: opts.eventBus,
        detailType: opts.detailType,
        rule: opts.ruleLabel,
      },
    },
  };
}

function buildEventBridgeConsumerSummary(
  opts: EventBridgeConsumerOpts,
): BehavioralSummary {
  const codeUri = opts.lambdaResource.Properties?.CodeUri;
  const codeScope =
    typeof codeUri === "string"
      ? { kind: "codeUri", path: normalizeCodeUri(codeUri) }
      : { kind: "unknown" };
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
        recognition: "cloudformation",
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
    metadata: {
      codeScope,
      messageBus: {
        rule: opts.ruleLabel,
        eventBus: opts.eventBus,
        patternResolution: opts.patternResolution,
        ...(opts.detailType !== undefined
          ? { detailType: opts.detailType }
          : {}),
        ...(opts.unresolvableReason !== undefined
          ? { unresolvableReason: opts.unresolvableReason }
          : {}),
      },
    },
  };
}

/**
 * Reduce a rule's EventPattern to the exact set of DetailTypes it
 * matches. v0 handles only a literal `detail-type` array; anything else
 * (absent detail-type, content-filter objects, empty array) is
 * unresolvable — surfaced by the checker, never silently dropped.
 */
function reduceEventPattern(pattern: unknown): PatternReduction {
  if (pattern === null || typeof pattern !== "object") {
    return {
      kind: "unresolvable",
      reason: "rule declares no EventPattern",
    };
  }
  const detailType = (pattern as Record<string, unknown>)["detail-type"];
  if (detailType === undefined) {
    return {
      kind: "unresolvable",
      reason:
        "EventPattern has no detail-type; v0 reduces routing to exact detail-type match only",
    };
  }
  if (!Array.isArray(detailType)) {
    return {
      kind: "unresolvable",
      reason: "detail-type is not a plain array of string literals",
    };
  }
  const detailTypes: string[] = [];
  for (const entry of detailType) {
    if (typeof entry !== "string") {
      return {
        kind: "unresolvable",
        reason:
          "detail-type contains a content filter (prefix / anything-but / etc.); pattern subsumption is out of v0 scope",
      };
    }
    detailTypes.push(entry);
  }
  if (detailTypes.length === 0) {
    return { kind: "unresolvable", reason: "detail-type array is empty" };
  }
  return { kind: "exact", detailTypes };
}

/**
 * Resolve a rule's EventBusName to the channel's bus token: the CFN
 * logical id when it's a Ref/GetAtt, the segmented name from an event-
 * bus ARN, the literal string otherwise, or "default" when omitted (the
 * EventBridge default event bus).
 */
function resolveEventBusToken(
  value: unknown,
  resources: Record<string, CloudFormationResource>,
): string {
  if (value === null || value === undefined) {
    return "default";
  }
  if (typeof value === "object") {
    const logicalId = resolveLogicalId(value);
    // Prefer the logical id even when the referenced resource isn't in
    // this template — the producer side chain-collapses to the same id.
    return logicalId ?? "default";
  }
  if (typeof value === "string") {
    const arnMatch = value.match(/:event-bus\/(.+)$/);
    if (arnMatch !== null) {
      return arnMatch[1];
    }
    return value;
  }
  void resources;
  return "default";
}

/**
 * Resolve a `Ref` / `Fn::GetAtt` reference (or bare logical-id string)
 * to the CFN logical id it names. Unlike the local `refTarget` used by
 * the SQS paths, this also unwraps `Fn::GetAtt` — EventBridge rule
 * targets reference Lambdas by `!GetAtt Fn.Arn`.
 */
function resolveLogicalId(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value !== "object") {
    return null;
  }
  const obj = value as Record<string, unknown>;
  if ("Ref" in obj && typeof obj.Ref === "string") {
    return obj.Ref;
  }
  const att = obj["Fn::GetAtt"];
  if (Array.isArray(att) && typeof att[0] === "string") {
    return att[0];
  }
  if (typeof att === "string") {
    const dot = att.indexOf(".");
    return dot !== -1 ? att.slice(0, dot) : att;
  }
  return null;
}

/**
 * Read a rule's Targets array and return the Lambda targets (resolved
 * to their CFN resource). Non-Lambda targets (SQS, SNS, Step Functions)
 * are out of v0 scope and skipped.
 */
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
    const lambdaId = resolveLogicalId(arn);
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
