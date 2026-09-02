/**
 * Pair the message sends a recognizer found in code against the queue
 * and topic providers a deployment template declares.
 *
 * The two sides rarely spell a channel the same way. Code refers to the
 * queue through an env var and the template refers to it by CFN resource,
 * so pairing collapses that chain first and only then compares
 * channels. Comparison is on the subject, with the bus required to
 * agree only when both sides give one; channelPairing.ts says why.
 *
 * Message bodies are compared too: what a producer writes at the send
 * against what the consumer reads off the message. Either side can be
 * opaque, and then nothing is compared, so silence is not agreement.
 */

import {
  deployedRefs,
  readMessageBusMetadata,
  referenceFromName,
  runsIn,
  summaryIdentifier,
  summaryRef,
  unitsByFile,
} from "@suss/behavioral-ir";
import { bindingIs, busIdentityKey } from "@suss/ir-core";

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
  readSetOf,
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

import type {
  BehavioralSummary,
  BoundaryBinding,
  Finding,
  MessageBusSemantics,
  MessageBusTechnology,
  UnitScope,
  UnitsByFile,
} from "@suss/behavioral-ir";
import type { ComparedPair } from "../pairing/comparedPair.js";
import type { CarriesPayload, ReadSet } from "../receive/inputContract.js";

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
    consumers.push(consumer);
  }
  const producers: ProducerRecord[] = interactionsOf(
    idx,
    "message-send",
    "message-bus",
  ).map((record) => ({ ...record, resolvedChannel: null }));

  const byFile = unitsByFile(summaries);
  resolveProducerChannels(producers, summaries);

  const providerChannels: ChannelSet = createChannelSet();
  const consumerChannels: ChannelSet = createChannelSet();
  const producerChannels: ChannelSet = createChannelSet();
  const disabledChannels: ChannelSet = createChannelSet();

  for (const c of disabledConsumers) {
    const ch = channelOf(c);
    if (ch !== null) {
      addChannel(disabledChannels, ch, summaryIdentifier(c));
    }
    const queue = consumedQueueOf(c);
    if (queue !== null) {
      addChannel(disabledChannels, queue, summaryIdentifier(c));
    }
  }
  for (const c of consumers) {
    const ch = channelOf(c);
    if (ch !== null) {
      addChannel(consumerChannels, ch, summaryIdentifier(c));
    }
    // A consumer channelled by subject still drains a concrete queue,
    // which would otherwise be reported unused.
    const queue = consumedQueueOf(c);
    if (queue !== null) {
      addChannel(consumerChannels, queue, summaryIdentifier(c));
    }
  }
  for (const r of codeReceivers) {
    const ch = channelOf(r);
    if (ch !== null) {
      addChannel(consumerChannels, ch, summaryIdentifier(r));
    }
  }
  for (const p of queueProviders) {
    const ch = channelOf(p);
    if (ch === null) {
      continue;
    }
    // messageBusProducerOrphan: a channel whose every subscription is
    // disabled has no one behind it, so it does not satisfy "someone
    // consumes this channel" and a producer sending to it is an orphan.
    if (declaredOnlyDisabled(ch, disabledChannels, consumerChannels)) {
      continue;
    }
    addChannel(providerChannels, ch, summaryIdentifier(p));
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
    const declarers = [
      ...pairingOwners(providerChannels, ch),
      ...pairingOwners(consumerChannels, ch),
    ];
    if (declarers.length === 0) {
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
    if (semantics?.name !== "message-bus" || semantics.channel === null) {
      continue;
    }
    if (hasPair(producerChannels, semantics.channel)) {
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
    // messageBusUnused: a channel routed only by disabled subscriptions
    // is switched off on purpose, not left over, and the disabled
    // finding on its consumer already says why nothing moves here.
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
    if (hasPair(producerChannels, semantics.channel) || drainers.length > 0) {
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

  // boundaryFieldUnknown: disabled subscriptions are not in `consumers`,
  // so their handlers' bodies are not compared. No message crosses a
  // disabled rule, so there is no drift to report on that path.
  findings.push(
    ...checkBodyShapes({
      cfnConsumers: consumers,
      producers,
      allSummaries: summaries,
      byFile,
    }),
  );

  return findings;
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

// ---------------------------------------------------------------------------
// Walkers
// ---------------------------------------------------------------------------

function channelOf(s: BehavioralSummary): string | null {
  const sem = s.identity.boundaryBinding?.semantics;
  return sem?.name === "message-bus" ? sem.channel : null;
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
 * Providers name their channels after template resources, so pairing
 * only succeeds on a resolved channel. Falling back to the env-var name
 * surfaces the producer as an orphan, which is the right thing to
 * report when resolution failed. Null means the code only works the
 * queue out at runtime, so there is nothing to pair on either way.
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
): void {
  const pointsAt = deployedRefs(summaries);

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
    // A recognizer that keeps the reference spells the bus `{X}`, and
    // an older one spells it `X`. One lookup takes both, so the two
    // recognizer generations resolve against the same template.
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

/** Null on every consumer but EventBridge, which is the only one marked. */
function readPatternResolution(
  summary: BehavioralSummary,
): "exact" | "schedule" | "unresolvable" | null {
  return readMessageBusMetadata(summary)?.patternResolution ?? null;
}

// ---------------------------------------------------------------------------
// Finding builders
// ---------------------------------------------------------------------------

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
    : `${producer.summary.identity.name} sends to ${semantics.messageBus} channel ${channelDisplay} but nothing in the analysed scope declares this channel, and no handler answers it. Likely cases: (a) the queue is declared in another stack we don't analyse (multi-repo); (b) work-in-progress before infra is wired up; (c) a real misconfiguration. Severity is warning rather than error because (a) and (b) are common false-positive sources.`;
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
    description: `${consumer.identity.name} is wired to receive messages from ${semantics.messageBus} channel "${semantics.channel}" but no code in the project sends to this channel. Either dead infra or the producer lives outside this repo.`,
    severity: "warning",
  };
}

/**
 * A subscription deployed switched off, `State: DISABLED` (#460). It
 * invokes nothing until someone turns it on, so the pass treats it as
 * absent wherever it would count as a consumer, and this one info
 * finding says why. Per finding kind:
 * - messageBusConsumerOrphan: not emitted for it; "nothing sends here"
 *   and "this is switched off" are different statements.
 * - messageBusProducerOrphan: it does not satisfy "someone consumes
 *   this channel", so a producer with only disabled subscribers is an
 *   orphan, and that finding says the subscription is disabled.
 * - messageBusUnused: skipped; switched off on purpose is not left over.
 * - boundaryFieldUnknown: its handler's bodies are not compared; no
 *   message crosses a disabled rule.
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
    description: `${semantics.messageBus} channel "${semantics.channel}" is declared in infrastructure but has no identified producer or consumer. Likely orphan resource left over from a removed feature.${caveat}`,
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
  return "the EventPattern couldn't be reduced to exact detail-types";
}

function unresolvableDescription(
  consumer: BehavioralSummary,
  semantics: MessageBusSemantics,
  meta: ReturnType<typeof readMessageBusMetadata>,
  reason: string,
): string {
  if (semantics.messageBus === "aws.sns") {
    const subscription = meta?.subscription ?? consumer.identity.name;
    return `SNS subscription "${subscription}" on topic "${semantics.channel}" routes to ${consumer.identity.name}, but ${reason}. It's surfaced as unpaired-unresolvable rather than dropped.`;
  }
  if (semantics.messageBus === "s3") {
    const notification = meta?.notification ?? consumer.identity.name;
    return `S3 notification "${notification}" on bucket "${semantics.channel}" routes to ${consumer.identity.name}, but ${reason}. It's surfaced as unpaired-unresolvable rather than dropped.`;
  }
  const rule = meta?.rule ?? consumer.identity.name;
  const eventBus = meta?.eventBus ?? "default";
  return `EventBridge rule "${rule}" on bus "${eventBus}" routes to ${consumer.identity.name}, but ${reason}. v0 pairs producers to rules on exact detail-type match, so this rule can't be paired, and it's surfaced as unpaired-unresolvable rather than dropped. Pattern subsumption (prefix / content-based filtering) is out of scope for now.`;
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

// ---------------------------------------------------------------------------
// Body-shape pairing
// ---------------------------------------------------------------------------

/**
 * A message arrives through the handler's event parameter. Every pack
 * that discovers a message handler gives that parameter this role.
 */
const isTheMessageParameter: CarriesPayload = (input) =>
  input.type === "parameter" && input.role === "event";

/**
 * What Lambda puts at the top of the event it hands a handler on each
 * bus. A handler reading one of these was given the envelope; one
 * reading none of them was given the parsed message by a wrapper.
 */
const LAMBDA_ENVELOPE_FIELDS: Partial<
  Record<MessageBusTechnology, readonly string[]>
> = {
  aws_sqs: ["Records"],
  "aws.sns": ["Records"],
  s3: ["Records"],
  eventbridge: [
    "version",
    "id",
    "detail-type",
    "source",
    "account",
    "time",
    "region",
    "resources",
    "detail",
  ],
};

interface ReceiveRecord {
  summary: BehavioralSummary;
  transitionId?: string;
  reads: ReadSet;
}

/**
 * An opaque body on either side is skipped without a finding, so a
 * missing finding here does not mean the two sides agree. The rule
 * itself, and the rest of what it declines to compare, is in
 * `receive/inputContract.ts`.
 */
function checkBodyShapes(opts: {
  cfnConsumers: BehavioralSummary[];
  producers: ProducerRecord[];
  allSummaries: BehavioralSummary[];
  byFile: UnitsByFile;
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

    const codeScope = readCodeScope(cfnConsumer);
    if (codeScope === null) {
      continue;
    }

    const receives = collectReceives(
      opts.allSummaries,
      {
        unit: cfnConsumer.identity.deployableUnit,
        codeScope,
      },
      opts.byFile,
    );
    if (receives.length === 0) {
      continue;
    }

    const supplied = suppliedBodies(opts.producers, channel);
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

function readCodeScope(summary: BehavioralSummary): string | null {
  const meta = summary.metadata as
    | { codeScope?: { kind?: string; path?: string } }
    | undefined;
  const scope = meta?.codeScope;
  if (scope?.kind !== "codeUri" || scope.path === undefined) {
    return null;
  }
  return scope.path;
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
 * out of it, so the envelope's own field names decide.
 */
function parameterReceive(summary: BehavioralSummary): ReceiveRecord | null {
  const binding = summary.identity.boundaryBinding;
  if (!bindingIs(binding, "message-bus")) {
    return null;
  }
  const result = readSetOf(summary, isTheMessageParameter);
  if (!result.read) {
    return null;
  }
  const envelope = LAMBDA_ENVELOPE_FIELDS[binding.semantics.messageBus];
  if (envelope === undefined) {
    return { summary, reads: result.reads };
  }
  if (readsThroughEnvelope(result.reads, envelope)) {
    return null;
  }
  return { summary, reads: { ...result.reads, rootedAtPayload: true } };
}

function readsThroughEnvelope(
  reads: ReadSet,
  envelope: readonly string[],
): boolean {
  return reads.paths.some((path) => envelope.includes(path[0] ?? ""));
}

/** Every body sent to this channel, opaque ones included. */
function suppliedBodies(
  producers: ProducerRecord[],
  channel: string,
): unknown[] {
  const out: unknown[] = [];
  for (const producer of producers) {
    const producerChannel = effectiveChannel(producer);
    if (producerChannel === null || !channelsPair(producerChannel, channel)) {
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
    description: `${receive.summary.identity.name} reads "${missingField}" off a message on ${semantics.messageBus} channel "${semantics.channel}" but no producer in the analysed scope sends "${missingField}". Likely a producer/consumer drift: the producer renamed or removed the field, or the consumer expects a field that was never sent.`,
    severity: "warning",
  };
}
