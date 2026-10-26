/**
 * Pair the message sends a recognizer found in code against the queue
 * and topic providers a deployment template declares.
 *
 * The two sides rarely write a channel the same way. Code refers to the
 * queue through an env var and the template refers to it by CFN resource,
 * so pairing resolves the env var first and then compares channels.
 * Channels pair on the subject, and the bus has to agree only when both
 * sides give one. The message-bus README explains why.
 *
 * Message bodies are compared too: what a producer writes at the send
 * against what the consumer reads off the message. When either side is
 * opaque nothing is compared, so no finding does not mean agreement.
 */

import {
  deployedRefs,
  deploymentScope,
  placeDeclared,
  readMessageBusMetadata,
  referenceFromName,
  runsIn,
  summaryIdentifier,
  summaryRef,
} from "@suss/behavioral-ir";
import {
  bindingIs,
  busIdentityKey,
  displayLabel,
  MESSAGE_BUS_TRAITS,
} from "@suss/ir-core";

import {
  buildInteractionIndex,
  type InteractionIndex,
  type InteractionRecord,
  interactionsOf,
  providersOf,
} from "../interactions/dispatcher.js";
import {
  compareSupplied,
  formatPath,
  messageBodyReadSet,
} from "../receive/inputContract.js";
import {
  addChannel,
  type ChannelSet,
  channelsPair,
  createChannelSet,
  formatChannel,
  hasPair,
  pairingOwners,
  parseChannel,
} from "./channelPairing.js";
import {
  type EventPattern,
  type PatternMatch,
  patternMatch,
  sentEventOf,
} from "./eventPatternMatch.js";

import type {
  BehavioralSummary,
  BoundaryBinding,
  DeploymentScope,
  Finding,
  MessageBusSemantics,
  UnitScope,
  UnitsByFile,
} from "@suss/behavioral-ir";
import type { ComparedPair } from "../pairing/comparedPair.js";
import type { ReadSet } from "../receive/inputContract.js";

type ProducerRecord = InteractionRecord<"message-send"> & {
  /** Null when no env var resolved to a template resource. */
  resolvedChannel: string | null;
};

export function checkMessageBus(
  summaries: BehavioralSummary[],
  index?: InteractionIndex,
  /** Where to record what this pass compared; see `ComparedPair`. */
  compared?: ComparedPair[],
): Finding[] {
  const findings: Finding[] = [];
  const idx = index ?? buildInteractionIndex(summaries);

  const messageBusSummaries = providersOf(idx, "message-bus");
  const queueProviders = messageBusSummaries.filter(
    (s) => s.kind === "library",
  );
  const allConsumers = messageBusSummaries.filter((s) => s.kind === "consumer");
  // A handler bound to a subject counts that channel as consumed, but is
  // never orphan-checked: reading a subject says nothing about who sends
  // it, and only a declared subscription does.
  const codeReceivers = messageBusSummaries.filter(
    (s) => s.kind !== "library" && s.kind !== "consumer",
  );
  // A schedule has no producer by design, so it is dropped rather than
  // reported as an orphan.
  const consumers: BehavioralSummary[] = [];
  const disabledConsumers: BehavioralSummary[] = [];
  for (const consumer of allConsumers) {
    // Disabled wins over unresolvable: the pattern does not matter
    // while the rule is off.
    if (readMessageBusMetadata(consumer)?.enabled === false) {
      disabledConsumers.push(consumer);
      findings.push(makeDisabledConsumerFinding(consumer));
      continue;
    }
    const resolution = readPatternResolution(consumer);
    if (resolution === "unresolvable") {
      findings.push(makeUnresolvableRuleFinding(consumer));
      continue;
    }
    if (resolution === "schedule") {
      continue;
    }
    if (!isWire(consumer) && (patternOf(consumer)?.unsettled ?? []).length) {
      findings.push(makeUnsettledPatternFinding(consumer));
    }
    consumers.push(consumer);
  }
  const producers: ProducerRecord[] = interactionsOf(
    idx,
    "message-send",
    "message-bus",
  ).map((record) => ({ ...record, resolvedChannel: null }));

  const deployment = deploymentScope(summaries);
  resolveProducerChannels(producers, summaries, deployment);

  // Who a send reaches by channel: providers, consumers and handlers
  // without a pattern. A rule with a pattern is matched by the pattern.
  const declaredChannels: ChannelSet = createChannelSet();
  // Who takes messages off a channel, for the unused check.
  const consumerChannels: ChannelSet = createChannelSet();
  const producerChannels: ChannelSet = createChannelSet();
  const disabledChannels: ChannelSet = createChannelSet();
  const patternDeclarers: PatternDeclarer[] = [];

  for (const c of disabledConsumers) {
    for (const ch of drainedChannels(c)) {
      addChannel(disabledChannels, ch, summaryIdentifier(c));
    }
  }
  for (const c of [...consumers, ...codeReceivers]) {
    for (const ch of drainedChannels(c)) {
      addChannel(consumerChannels, ch, summaryIdentifier(c));
    }
  }
  for (const c of [...consumers, ...codeReceivers]) {
    declare(c, declaredChannels, patternDeclarers);
  }
  for (const p of queueProviders) {
    const ch = channelOf(p);
    // A channel whose every subscription is disabled has no receiver, so
    // a producer sending to it is still an orphan.
    if (
      ch === null ||
      declaredOnlyDisabled(ch, disabledChannels, consumerChannels)
    ) {
      continue;
    }
    declare(p, declaredChannels, patternDeclarers);
  }
  for (const p of producers) {
    const ch = effectiveChannel(p);
    if (ch !== null) {
      addChannel(producerChannels, ch, summaryIdentifier(p.summary));
    }
  }

  // A handler bound to the subject counts as a declaration, so a
  // producer sending to it pairs even when no queue in scope has that
  // name.
  for (const p of producers) {
    const semantics = p.effect.binding.semantics;
    if (semantics.name !== "message-bus") {
      continue;
    }
    const ch = effectiveChannel(p);
    if (ch === null) {
      continue;
    }
    const byPattern = patternDeclarers
      .map((declarer) => ({ declarer, match: sendMatches(declarer, p) }))
      .filter((hit) => hit.match !== null);
    const declarers = [
      ...pairingOwners(declaredChannels, ch),
      ...byPattern
        .filter((hit) => hit.match === "certain")
        .map((hit) => hit.declarer.owner),
    ];
    // A template's wire and a job sent by name are never orphan producers
    // (see the README).
    if (declarers.length === 0 && byPattern.length === 0) {
      if (
        isWire(p.summary) ||
        MESSAGE_BUS_TRAITS[semantics.messageBus].jobQueue
      ) {
        continue;
      }
      findings.push(
        makeOrphanProducerFinding(p, semantics, ch, {
          onlySubscriberDisabled: hasPair(disabledChannels, ch),
        }),
      );
      continue;
    }
    recordCompared(compared, semantics.messageBus, ch, declarers, [
      summaryIdentifier(p.summary),
    ]);
  }

  for (const c of consumers) {
    const semantics = c.identity.boundaryBinding?.semantics;
    // A wire the template declares has no code to be missing a producer.
    // A rule that lists no detail-type is not waiting on any one subject,
    // and its sender is often a service integration suss does not read.
    if (
      semantics?.name !== "message-bus" ||
      semantics.channel === null ||
      isWire(c) ||
      readPatternResolution(c) === "pattern"
    ) {
      continue;
    }
    if (isProducedTo(c, semantics.channel, producers, producerChannels)) {
      continue;
    }
    // A scheduler config the run does not read may enqueue this job.
    if (MESSAGE_BUS_TRAITS[semantics.messageBus].scheduledFromConfig) {
      continue;
    }
    findings.push(makeOrphanConsumerFinding(c, semantics));
  }

  // A send whose queue the code only works out at runtime could reach
  // any queue on its own bus, so the unused finding says how many of
  // those sends there were.
  const unnamedSendsByBus = new Map<string, number>();
  for (const p of producers) {
    const sendSemantics = p.effect.binding.semantics;
    if (
      sendSemantics.name === "message-bus" &&
      sendSemantics.channel === null
    ) {
      unnamedSendsByBus.set(
        sendSemantics.messageBus,
        (unnamedSendsByBus.get(sendSemantics.messageBus) ?? 0) + 1,
      );
    }
  }
  for (const p of queueProviders) {
    const semantics = p.identity.boundaryBinding?.semantics;
    if (semantics?.name !== "message-bus" || semantics.channel === null) {
      continue;
    }
    // A channel routed only by disabled subscriptions was switched off on
    // purpose, and the disabled finding on its consumer explains it.
    if (
      declaredOnlyDisabled(
        semantics.channel,
        disabledChannels,
        consumerChannels,
      )
    ) {
      continue;
    }
    const drainers = pairingOwners(consumerChannels, semantics.channel);
    if (
      drainers.length > 0 ||
      isProducedTo(p, semantics.channel, producers, producerChannels)
    ) {
      recordCompared(
        compared,
        semantics.messageBus,
        semantics.channel,
        [summaryIdentifier(p)],
        drainers,
      );
      continue;
    }
    findings.push(
      makeUnusedQueueFinding(
        p,
        semantics,
        unnamedSendsByBus.get(semantics.messageBus) ?? 0,
      ),
    );
  }

  // Disabled subscriptions are not in `consumers`, so their handlers'
  // bodies are not compared. No message crosses a disabled rule.
  findings.push(
    ...checkBodyShapes({
      cfnConsumers: consumers,
      producers,
      allSummaries: summaries,
      deployment,
    }),
  );

  findings.push(
    ...checkRepeatSafety({
      consumers,
      queueProviders,
      allSummaries: summaries,
      deployment,
    }),
  );

  return findings;
}

/**
 * The method that creates something on the far side. PUT, PATCH and
 * DELETE all land on the same resource twice, so a second delivery
 * leaves them where the first one did.
 */
const REPEATS_HARM = new Set(["POST"]);

/**
 * A channel a broker can deliver twice, reaching a consumer that posts
 * to another service. An SQS queue redelivers unless it is FIFO, and a
 * second POST is a second charge or a second order unless the far side
 * takes an idempotency key, which the summary does not record.
 */
function checkRepeatSafety(opts: {
  consumers: BehavioralSummary[];
  queueProviders: BehavioralSummary[];
  allSummaries: BehavioralSummary[];
  deployment: DeploymentScope;
}): Finding[] {
  const findings: Finding[] = [];
  for (const consumer of opts.consumers) {
    const semantics = consumer.identity.boundaryBinding?.semantics;
    if (semantics?.name !== "message-bus" || semantics.channel === null) {
      continue;
    }
    if (!redelivers(semantics, opts.queueProviders)) {
      continue;
    }
    const scope = placeDeclared(consumer, opts.deployment.graph);
    if (scope === null) {
      continue;
    }
    for (const summary of opts.allSummaries) {
      if (!runsIn(summary, scope, opts.deployment.byFile)) {
        continue;
      }
      for (const call of repeatedCalls(summary)) {
        findings.push(
          makeRepeatUnsafeFinding(consumer, semantics, summary, call),
        );
      }
    }
  }
  return findings;
}

/**
 * Whether the broker can deliver one message twice. An SQS queue does
 * unless the template declares it FIFO, and a channel nothing in the
 * run declares says nothing either way, so it is left alone.
 */
function redelivers(
  semantics: MessageBusSemantics,
  queueProviders: BehavioralSummary[],
): boolean {
  if (semantics.messageBus !== "aws_sqs") {
    return false;
  }
  const declared = queueProviders.find((provider) => {
    const own = provider.identity.boundaryBinding?.semantics;
    return own?.name === "message-bus" && own.channel === semantics.channel;
  });
  return (
    declared !== undefined &&
    readMessageBusMetadata(declared)?.fifoQueue !== true
  );
}

/** A call a second delivery would make again. `label` includes the method. */
interface RepeatedCall {
  callee: string | undefined;
  label: string;
}

/**
 * A call out of this unit that a second delivery would make again.
 *
 * The TypeScript packs record one as a service-call effect inside the
 * body. The Python and Ruby client packs make the calling function a
 * unit of its own, bound to the route it calls. Both forms are read
 * here, so a consumer in any of the three languages gets the same
 * finding.
 */
function repeatedCalls(summary: BehavioralSummary): RepeatedCall[] {
  const own = summary.identity.boundaryBinding;
  if (
    summary.kind === "client" &&
    own?.semantics.name === "rest" &&
    own.semantics.method !== null &&
    REPEATS_HARM.has(own.semantics.method.toUpperCase())
  ) {
    return [{ callee: undefined, label: displayLabel(own) }];
  }

  const found: RepeatedCall[] = [];
  const seen = new Set<string>();
  for (const transition of summary.transitions) {
    for (const effect of transition.effects) {
      if (
        effect.type !== "interaction" ||
        effect.interaction.class !== "service-call" ||
        !REPEATS_HARM.has(effect.interaction.method.toUpperCase())
      ) {
        continue;
      }
      const label = displayLabel(effect.binding);
      if (seen.has(label)) {
        continue;
      }
      seen.add(label);
      found.push({ callee: effect.callee, label });
    }
  }
  return found;
}

function makeRepeatUnsafeFinding(
  consumer: BehavioralSummary,
  semantics: MessageBusSemantics,
  handler: BehavioralSummary,
  call: RepeatedCall,
): Finding {
  const binding = consumer.identity.boundaryBinding as BoundaryBinding;
  const through = call.callee === undefined ? "" : ` through ${call.callee}`;
  return {
    kind: "repeatUnsafeConsumer",
    boundary: binding,
    provider: makeSide(consumer),
    consumer: makeSide(handler),
    description: `SQS queue "${semantics.channel}" can deliver one message more than once, and ${handler.identity.name} makes ${call.label}${through} while handling it. A second delivery makes that call again. If the far side takes an idempotency key and this call sends one, the repeat is harmless and the finding can be accepted. A summary does not record the headers a call sends, so suss cannot tell.`,
    severity: "warning",
  };
}

/**
 * Every declaring side against every sending side, keyed the way a
 * finding on this channel is keyed so a reader sees one spelling.
 */
function recordCompared(
  compared: ComparedPair[] | undefined,
  messageBus: MessageBusSemantics["messageBus"],
  channel: string,
  declarers: string[],
  senders: string[],
): void {
  if (compared === undefined) {
    return;
  }
  const key = busIdentityKey(messageBus, parseChannel(channel).subject);
  for (const provider of declarers) {
    for (const consumer of senders) {
      // One summary that both declares a subject and sends to it has
      // not been compared against anything.
      if (provider !== consumer) {
        compared.push({ key, provider, consumer });
      }
    }
  }
}

function channelOf(s: BehavioralSummary): string | null {
  const sem = s.identity.boundaryBinding?.semantics;
  return sem?.name === "message-bus" ? sem.channel : null;
}

/** A summary the template declares to move messages, such as a redrive. */
function isWire(s: BehavioralSummary): boolean {
  return readMessageBusMetadata(s)?.wiring !== undefined;
}

function patternOf(s: BehavioralSummary): EventPattern | undefined {
  return readMessageBusMetadata(s)?.eventPattern;
}

/** A rule's summary, which a send reaches by matching its pattern. */
interface PatternDeclarer {
  owner: string;
  bus: string | null;
  pattern: EventPattern;
}

/** Its own channel, and the queue it drains when it took a subject's channel. */
function drainedChannels(s: BehavioralSummary): string[] {
  return [channelOf(s), consumedQueueOf(s)].filter(
    (ch): ch is string => ch !== null,
  );
}

/**
 * Adds a summary to what sends can reach. A rule's summary goes on the
 * pattern list, and only the queue it drains, if any, is a channel.
 */
function declare(
  s: BehavioralSummary,
  channels: ChannelSet,
  patterns: PatternDeclarer[],
): void {
  const owner = summaryIdentifier(s);
  const pattern = patternOf(s);
  const ch = channelOf(s);
  if (pattern === undefined || ch === null) {
    for (const drained of drainedChannels(s)) {
      addChannel(channels, drained, owner);
    }
    return;
  }
  patterns.push({ owner, bus: parseChannel(ch).bus, pattern });
  const queue = consumedQueueOf(s);
  if (queue !== null) {
    addChannel(channels, queue, owner);
  }
}

/** How a send reaches a rule, or null when it does not. Only EventBridge sends do. */
function sendMatches(
  declarer: { bus: string | null; pattern: EventPattern },
  p: ProducerRecord,
): PatternMatch | null {
  const sem = p.effect.binding.semantics;
  const ch = effectiveChannel(p);
  if (sem.name !== "message-bus" || sem.messageBus !== "eventbridge") {
    return null;
  }
  if (ch === null || p.effect.interaction.class !== "message-send") {
    return null;
  }

  return patternMatch(
    declarer.pattern,
    declarer.bus,
    sentEventOf(ch, p.effect.interaction.routingKey),
  );
}

/**
 * Whether anything sends to this summary's channel, or to the queue it
 * drains. A rule whose pattern AWS services send to is sent to with no
 * code doing it, and a possible match counts, since a finding needs
 * certainty that nothing sends.
 */
function isProducedTo(
  s: BehavioralSummary,
  channel: string,
  producers: ProducerRecord[],
  producerChannels: ChannelSet,
): boolean {
  const queue = consumedQueueOf(s);
  if (queue !== null && hasPair(producerChannels, queue)) {
    return true;
  }
  const pattern = patternOf(s);
  if (pattern === undefined) {
    return hasPair(producerChannels, channel);
  }
  if (pattern.emittedByAws === true) {
    return true;
  }
  const declarer = { bus: parseChannel(channel).bus, pattern };

  return producers.some((p) => sendMatches(declarer, p) !== null);
}

/**
 * Whether every subscription on this channel is deployed disabled. Two
 * rules can route one channel, so a disabled rule only takes the
 * channel out of pairing when no enabled consumer is on it too.
 */
function declaredOnlyDisabled(
  channel: string,
  disabledChannels: ChannelSet,
  consumerChannels: ChannelSet,
): boolean {
  return (
    hasPair(disabledChannels, channel) && !hasPair(consumerChannels, channel)
  );
}

/**
 * The CFN logical id of the queue a subject-channelled SQS consumer
 * drains, or null when the consumer's channel is already the queue name.
 */
function consumedQueueOf(s: BehavioralSummary): string | null {
  return readMessageBusMetadata(s)?.queue ?? null;
}

/**
 * Providers use template resource names for their channels, so only a
 * resolved channel pairs. When resolution failed the env var name is
 * used, and the producer is reported as an orphan, which is correct.
 * Null means the code picks the queue at run time, so there is nothing
 * to pair on.
 */
function effectiveChannel(p: ProducerRecord): string | null {
  if (p.resolvedChannel !== null) {
    return p.resolvedChannel;
  }
  const sem = p.effect.binding.semantics;
  if (sem.name !== "message-bus") {
    return null;
  }

  return sem.channel;
}

/**
 * A recognizer can only see the env var a send reads, so this looks the
 * name up in the environment of whichever runtime deploys that file and
 * records the resource it points at.
 */
function resolveProducerChannels(
  producers: ProducerRecord[],
  summaries: BehavioralSummary[],
  deployment: DeploymentScope,
): void {
  const pointsAt = deployedRefs(summaries, deployment);

  for (const producer of producers) {
    const semantics = producer.effect.binding.semantics;
    if (semantics.name !== "message-bus") {
      continue;
    }

    // Skipping keeps a resolved channel from outranking a null one in
    // `effectiveChannel`, whatever a template happens to contain.
    if (semantics.channel === null) {
      continue;
    }

    const { busToken, detailSuffix } = splitBusChannel(
      semantics.messageBus,
      semantics.channel,
    );
    // A recognizer that keeps the reference writes the bus as `{X}`, and
    // older summaries write `X`. The lookup accepts both.
    const variable = referenceFromName(busToken)?.root ?? busToken;
    const logicalId = pointsAt(producer.summary, variable);
    if (logicalId !== null) {
      producer.resolvedChannel =
        detailSuffix === null
          ? logicalId
          : formatChannel(logicalId, detailSuffix);
    }
  }
}

/**
 * Only EventBridge writes two things into one channel. Elsewhere a `#`
 * is part of the queue or topic name.
 */
function channelNamesBusAndSubject(
  messageBus: MessageBusSemantics["messageBus"],
): boolean {
  return messageBus === "eventbridge";
}

/** Only the bus token resolves through an env var; the detail is put
 * back afterwards. */
function splitBusChannel(
  messageBus: MessageBusSemantics["messageBus"],
  channel: string,
): {
  busToken: string;
  detailSuffix: string | null;
} {
  if (!channelNamesBusAndSubject(messageBus)) {
    return { busToken: channel, detailSuffix: null };
  }

  const { bus, subject } = parseChannel(channel);
  if (bus === null) {
    return { busToken: channel, detailSuffix: null };
  }

  return { busToken: bus, detailSuffix: subject };
}

/** How the reader resolved the consumer's routing pattern, or null when it recorded nothing. */
function readPatternResolution(
  summary: BehavioralSummary,
): "exact" | "pattern" | "schedule" | "unresolvable" | null {
  return readMessageBusMetadata(summary)?.patternResolution ?? null;
}

function makeOrphanProducerFinding(
  producer: ProducerRecord,
  semantics: MessageBusSemantics,
  effectiveCh: string,
  opts: { onlySubscriberDisabled: boolean },
): Finding {
  // Showing both channels lets a reader tell a failed env-var resolution
  // apart from a missing provider.
  const original = semantics.channel;
  const channelDisplay =
    effectiveCh === original
      ? `"${original}"`
      : `"${effectiveCh}" (resolved from env var "${original}")`;
  const description = opts.onlySubscriberDisabled
    ? `${producer.summary.identity.name} sends to ${semantics.messageBus} channel ${channelDisplay}, and the only subscription on this channel is deployed disabled, so nothing receives what it sends until someone switches the subscription on.`
    : `${producer.summary.identity.name} sends to ${semantics.messageBus} channel ${channelDisplay}, but nothing in this run declares the channel and no handler receives from it. The channel may be declared in a stack or repository this run did not read, or not be set up yet. If neither is true, the channel name is wrong.`;
  return {
    kind: "messageBusProducerOrphan",
    boundary: producer.effect.binding,
    provider: makeSide(producer.summary, producer.transitionId),
    consumer: makeSide(producer.summary, producer.transitionId),
    description,
    severity: "warning",
  };
}

function makeOrphanConsumerFinding(
  consumer: BehavioralSummary,
  semantics: MessageBusSemantics,
): Finding {
  const binding = consumer.identity.boundaryBinding as BoundaryBinding;
  return {
    kind: "messageBusConsumerOrphan",
    boundary: binding,
    provider: makeSide(consumer),
    consumer: makeSide(consumer),
    description: `${consumer.identity.name} is wired to receive messages from ${semantics.messageBus} channel "${semantics.channel}" but no code in the project sends to this channel. Either nothing uses the channel any more, or the producer lives outside this repository.`,
    severity: "warning",
  };
}

/**
 * A rule whose pattern filters source or detail-type with something
 * other than a list of strings, such as a prefix. Every send on the bus
 * may reach it, so it is never an orphan, and nothing is compared.
 */
function makeUnsettledPatternFinding(consumer: BehavioralSummary): Finding {
  const binding = consumer.identity.boundaryBinding as BoundaryBinding;
  const meta = readMessageBusMetadata(consumer);
  const fields = (meta?.eventPattern?.unsettled ?? []).join(" and ");
  return {
    kind: "unsupportedSemantics",
    boundary: binding,
    provider: makeSide(consumer),
    consumer: makeSide(consumer),
    description: `EventBridge rule "${meta?.rule ?? consumer.identity.name}" on bus "${meta?.eventBus ?? "default"}" routes to ${consumer.identity.name}, but its pattern filters ${fields} with something other than a list of strings, such as a prefix. suss counts any send on the bus as one that may reach it, so it is not reported as an orphan, and what reaches it went unchecked.`,
    severity: "info",
  };
}

/**
 * A subscription deployed with `State: DISABLED` (#460) invokes nothing
 * until someone turns it on. The pass treats it as absent wherever it
 * would count as a consumer, and this info finding explains why. It is
 * never reported as a consumer orphan. A producer whose only
 * subscriptions are disabled is an orphan, and its finding says so. A
 * queue it routes is not reported unused, and its handler's bodies are
 * not compared. The message-bus README has the details.
 */
function makeDisabledConsumerFinding(consumer: BehavioralSummary): Finding {
  const binding = consumer.identity.boundaryBinding as BoundaryBinding;
  const semantics = binding.semantics as MessageBusSemantics;
  const meta = readMessageBusMetadata(consumer);
  const rule = meta?.rule ?? consumer.identity.name;
  return {
    kind: "messageBusConsumerDisabled",
    boundary: binding,
    provider: makeSide(consumer),
    consumer: makeSide(consumer),
    description: `${consumer.identity.name} is wired to ${semantics.messageBus} channel "${semantics.channel}" through "${rule}", which is deployed disabled. It receives nothing until someone switches it on, so it is not counted as a consumer of the channel.`,
    severity: "info",
  };
}

function makeUnusedQueueFinding(
  provider: BehavioralSummary,
  semantics: MessageBusSemantics,
  unnamedSendCount: number,
): Finding {
  const binding = provider.identity.boundaryBinding as BoundaryBinding;
  const caveat =
    unnamedSendCount === 0
      ? ""
      : ` ${unnamedSendCount} send${unnamedSendCount === 1 ? "" : "s"} in scope name${unnamedSendCount === 1 ? "s" : ""} the queue at runtime and could target it.`;
  return {
    kind: "messageBusUnused",
    boundary: binding,
    provider: makeSide(provider),
    consumer: makeSide(provider),
    description: `${semantics.messageBus} channel "${semantics.channel}" is declared in infrastructure, but nothing in this run sends to it or receives from it. It is often left over from a feature that was removed.${caveat}`,
    severity: "warning",
  };
}

function makeUnresolvableRuleFinding(consumer: BehavioralSummary): Finding {
  const binding = consumer.identity.boundaryBinding as BoundaryBinding;
  const semantics = binding.semantics as MessageBusSemantics;
  const meta = readMessageBusMetadata(consumer);
  const reason =
    meta?.unresolvableReason ?? defaultUnresolvableReason(semantics.messageBus);
  return {
    kind: "unsupportedSemantics",
    boundary: binding,
    provider: makeSide(consumer),
    consumer: makeSide(consumer),
    description: unresolvableDescription(consumer, semantics, meta, reason),
    severity: "info",
  };
}

/** Every writer of this state also sets `unresolvableReason`, so this is a backstop. */
function defaultUnresolvableReason(
  messageBus: MessageBusSemantics["messageBus"],
): string {
  if (messageBus === "aws.sns") {
    return "the FilterPolicy couldn't be reduced to the whole topic";
  }
  if (messageBus === "s3") {
    return "the Filter couldn't be reduced to the whole bucket";
  }
  return "the rule declares no EventPattern";
}

function unresolvableDescription(
  consumer: BehavioralSummary,
  semantics: MessageBusSemantics,
  meta: ReturnType<typeof readMessageBusMetadata>,
  reason: string,
): string {
  if (semantics.messageBus === "aws.sns") {
    const subscription = meta?.subscription ?? consumer.identity.name;
    return `SNS subscription "${subscription}" on topic "${semantics.channel}" routes to ${consumer.identity.name}, but ${reason}. No producer was paired with it, so what reaches it went unchecked.`;
  }
  if (semantics.messageBus === "s3") {
    const notification = meta?.notification ?? consumer.identity.name;
    return `S3 notification "${notification}" on bucket "${semantics.channel}" routes to ${consumer.identity.name}, but ${reason}. No producer was paired with it, so what reaches it went unchecked.`;
  }
  const rule = meta?.rule ?? consumer.identity.name;
  const eventBus = meta?.eventBus ?? "default";
  return `EventBridge rule "${rule}" on bus "${eventBus}" routes to ${consumer.identity.name}, but ${reason}. No producer was paired with it, so what reaches it went unchecked.`;
}

function makeSide(
  summary: BehavioralSummary,
  transitionId?: string,
): {
  summary: string;
  location: BehavioralSummary["location"];
  transitionId?: string;
} {
  return {
    summary: summaryRef(summary),
    location: summary.location,
    ...(transitionId !== undefined ? { transitionId } : {}),
  };
}

interface ReceiveRecord {
  summary: BehavioralSummary;
  transitionId?: string;
  reads: ReadSet;
}

/**
 * An opaque body on either side is skipped without a finding, so a
 * missing finding here does not mean the two sides agree. The rule,
 * and the other cases it skips, are in `compareSupplied`.
 */
function checkBodyShapes(opts: {
  cfnConsumers: BehavioralSummary[];
  producers: ProducerRecord[];
  allSummaries: BehavioralSummary[];
  deployment: DeploymentScope;
}): Finding[] {
  const findings: Finding[] = [];
  for (const cfnConsumer of opts.cfnConsumers) {
    const semantics = cfnConsumer.identity.boundaryBinding?.semantics;
    if (semantics?.name !== "message-bus") {
      continue;
    }
    const channel = semantics.channel;
    if (channel === null) {
      continue;
    }

    const scope = placeDeclared(cfnConsumer, opts.deployment.graph);
    if (scope === null) {
      continue;
    }

    const receives = collectReceives(
      opts.allSummaries,
      scope,
      opts.deployment.byFile,
    );
    if (receives.length === 0) {
      continue;
    }

    const supplied = suppliedBodies(cfnConsumer, opts.producers, channel);
    if (supplied === null) {
      continue;
    }
    for (const receive of receives) {
      const result = compareSupplied(receive.reads, supplied);
      if (!result.compared) {
        continue;
      }
      for (const path of result.unsupplied) {
        findings.push(
          makeBodyShapeFinding(
            cfnConsumer,
            semantics,
            receive,
            formatPath(path),
          ),
        );
      }
    }
  }
  return findings;
}

/**
 * What the code deployed as this consumer reads out of a message.
 *
 * A destructure of the parsed body is the better reading, because it
 * starts at what the producer wrote. The handler's own parameter is
 * used only when there is no such destructure.
 */
function collectReceives(
  summaries: BehavioralSummary[],
  scope: UnitScope,
  byFile: UnitsByFile,
): ReceiveRecord[] {
  const out: ReceiveRecord[] = [];
  for (const summary of summaries) {
    if (!runsIn(summary, scope, byFile)) {
      continue;
    }
    const destructured = destructuredReceives(summary);
    if (destructured.length > 0) {
      out.push(...destructured);
      continue;
    }
    const parameter = parameterReceive(summary);
    if (parameter !== null) {
      out.push(parameter);
    }
  }
  return out;
}

/** The fields a `message-receive` effect pulled out of the parsed body. */
function destructuredReceives(summary: BehavioralSummary): ReceiveRecord[] {
  const out: ReceiveRecord[] = [];
  for (const transition of summary.transitions) {
    for (const effect of transition.effects) {
      if (
        effect.type !== "interaction" ||
        effect.interaction.class !== "message-receive"
      ) {
        continue;
      }
      const fields = readObjectBodyFields(effect.interaction.body);
      if (fields === null) {
        continue;
      }
      out.push({
        summary,
        transitionId: transition.id,
        reads: {
          paths: fields.map((field) => [field]),
          rootedAtPayload: true,
        },
      });
    }
  }
  return out;
}

/**
 * The message-bus binding is what makes this unit the receiver rather
 * than a helper deployed beside it, whose inputs come from its caller.
 * The summary cannot tell the envelope from a message a wrapper parsed
 * out of it, so the envelope's own field names settle which it is.
 */
function parameterReceive(summary: BehavioralSummary): ReceiveRecord | null {
  const binding = summary.identity.boundaryBinding;
  if (!bindingIs(binding, "message-bus")) {
    return null;
  }
  const result = messageBodyReadSet(summary, binding.semantics.messageBus);
  if (!result.read) {
    return null;
  }
  return { summary, reads: result.reads };
}

/**
 * Every body sent to this channel, opaque ones included. A rule's
 * consumer takes the bodies of every send its pattern may match, and is
 * compared only when at least one send matches it for certain.
 */
function suppliedBodies(
  consumer: BehavioralSummary,
  producers: ProducerRecord[],
  channel: string,
): unknown[] | null {
  const pattern = patternOf(consumer);
  const matches = producers.map((producer) =>
    pattern === undefined
      ? channelMatch(producer, channel)
      : sendMatches({ bus: parseChannel(channel).bus, pattern }, producer),
  );
  if (pattern !== undefined && !matches.includes("certain")) {
    return null;
  }
  const out: unknown[] = [];
  for (const [index, producer] of producers.entries()) {
    if (matches[index] === null) {
      continue;
    }
    const sent = producer.effect.interaction;
    if (sent.class !== "message-send") {
      continue;
    }
    out.push(sent.body);
  }
  return out;
}

function channelMatch(
  producer: ProducerRecord,
  channel: string,
): PatternMatch | null {
  const producerChannel = effectiveChannel(producer);
  return producerChannel !== null && channelsPair(producerChannel, channel)
    ? "certain"
    : null;
}

/** Null for any body that is not an object literal, which is opaque here. */
function readObjectBodyFields(body: unknown): string[] | null {
  if (body === null || body === undefined || typeof body !== "object") {
    return null;
  }
  const candidate = body as { kind?: string; fields?: Record<string, unknown> };
  if (candidate.kind !== "object" || candidate.fields === undefined) {
    return null;
  }
  return Object.keys(candidate.fields);
}

function makeBodyShapeFinding(
  cfnConsumer: BehavioralSummary,
  semantics: MessageBusSemantics,
  receive: ReceiveRecord,
  missingField: string,
): Finding {
  const binding = cfnConsumer.identity.boundaryBinding as BoundaryBinding;
  return {
    kind: "boundaryFieldUnknown",
    aspect: "receive",
    boundary: binding,
    provider: makeSide(cfnConsumer),
    consumer: makeSide(receive.summary, receive.transitionId),
    description: `${receive.summary.identity.name} reads "${missingField}" off a message on ${semantics.messageBus} channel "${semantics.channel}" but no producer in this run sends "${missingField}". Either a producer renamed or removed the field, or the consumer expects a field that was never sent.`,
    severity: "warning",
  };
}
