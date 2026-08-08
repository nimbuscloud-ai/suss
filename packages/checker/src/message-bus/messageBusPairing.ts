/**
 * Pair the message sends a recognizer found in code against the queue
 * and topic providers a deployment template declares.
 *
 * The two sides rarely spell a channel the same way. Code refers to the
 * queue through an env var and the template refers to it by CFN resource,
 * so pairing collapses that chain first and only then compares
 * channels. Comparison is on the subject, with the bus required to
 * agree only when both sides carry one; channelPairing.ts says why.
 *
 * Message bodies are compared too, producer object literals against
 * consumer destructuring. Either side can be opaque, and then the
 * comparison is skipped, so a missing finding is not agreement.
 */

import {
  readMessageBusMetadata,
  readRuntimeContractMetadata,
  summaryRef,
} from "@suss/behavioral-ir";

import {
  buildInteractionIndex,
  type InteractionIndex,
  type InteractionRecord,
  interactionsOf,
  providersOf,
} from "../interactions/dispatcher.js";
import {
  runsIn,
  type UnitScope,
  type UnitsByFile,
  unitsByFile,
} from "../scope/unitScope.js";
import {
  addChannel,
  type ChannelSet,
  channelsPair,
  createChannelSet,
  formatChannel,
  hasPair,
  parseChannel,
} from "./channelPairing.js";

import type {
  BehavioralSummary,
  BoundaryBinding,
  Finding,
  MessageBusSemantics,
} from "@suss/behavioral-ir";

type ProducerRecord = InteractionRecord<"message-send"> & {
  /** Null when no env var resolved to a template resource. */
  resolvedChannel: string | null;
};

export function checkMessageBus(
  summaries: BehavioralSummary[],
  index?: InteractionIndex,
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
  for (const consumer of allConsumers) {
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
  resolveProducerChannels(producers, summaries, byFile);

  const providerChannels: ChannelSet = createChannelSet();
  const consumerChannels: ChannelSet = createChannelSet();
  const producerChannels: ChannelSet = createChannelSet();

  for (const p of queueProviders) {
    const ch = channelOf(p);
    if (ch !== null) {
      addChannel(providerChannels, ch);
    }
  }
  for (const c of consumers) {
    const ch = channelOf(c);
    if (ch !== null) {
      addChannel(consumerChannels, ch);
    }
    // A consumer channelled by subject still drains a concrete queue,
    // which would otherwise be reported unused.
    const queue = consumedQueueOf(c);
    if (queue !== null) {
      addChannel(consumerChannels, queue);
    }
  }
  for (const r of codeReceivers) {
    const ch = channelOf(r);
    if (ch !== null) {
      addChannel(consumerChannels, ch);
    }
  }
  for (const p of producers) {
    const ch = effectiveChannel(p);
    if (ch !== null) {
      addChannel(producerChannels, ch);
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
    if (
      ch === null ||
      hasPair(providerChannels, ch) ||
      hasPair(consumerChannels, ch)
    ) {
      continue;
    }
    findings.push(makeOrphanProducerFinding(p, semantics, ch));
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
    if (
      hasPair(producerChannels, semantics.channel) ||
      hasPair(consumerChannels, semantics.channel)
    ) {
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

// ---------------------------------------------------------------------------
// Walkers
// ---------------------------------------------------------------------------

function channelOf(s: BehavioralSummary): string | null {
  const sem = s.identity.boundaryBinding?.semantics;
  return sem?.name === "message-bus" ? sem.channel : null;
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
  byFile: UnitsByFile,
): void {
  const runtimeProviders = summaries.filter(
    (s) =>
      s.kind === "library" &&
      s.identity.boundaryBinding?.semantics.name === "runtime-config",
  );

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
    const runtime = runtimeRunning(runtimeProviders, producer.summary, byFile);
    if (runtime === null) {
      continue;
    }
    const targets = readEnvVarTargets(runtime);
    const target = targets[busToken];
    if (target !== undefined) {
      producer.resolvedChannel =
        detailSuffix === null
          ? target.logicalId
          : formatChannel(target.logicalId, detailSuffix);
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

/** The runtime whose environment this producer's code is deployed with. */
function runtimeRunning(
  runtimes: BehavioralSummary[],
  producer: BehavioralSummary,
  byFile: UnitsByFile,
): BehavioralSummary | null {
  for (const runtime of runtimes) {
    const meta = runtime.metadata as
      | { codeScope?: { kind?: string; path?: string } }
      | undefined;
    const scope = meta?.codeScope;
    if (scope?.kind !== "codeUri" || scope.path === undefined) {
      continue;
    }
    const inUnit = runsIn(
      producer,
      {
        unit: runtime.identity.deployableUnit,
        codeScope: scope.path,
      },
      byFile,
    );
    if (inUnit) {
      return runtime;
    }
  }
  return null;
}

function readEnvVarTargets(
  runtime: BehavioralSummary,
): Record<string, { kind: "ref"; logicalId: string }> {
  return readRuntimeContractMetadata(runtime)?.envVarTargets ?? {};
}

// ---------------------------------------------------------------------------
// Finding builders
// ---------------------------------------------------------------------------

function makeOrphanProducerFinding(
  producer: ProducerRecord,
  semantics: MessageBusSemantics,
  effectiveCh: string,
): Finding {
  // Showing both channels lets a reader tell a failed env-var resolution
  // apart from a missing provider.
  const original = semantics.channel;
  const channelDisplay =
    effectiveCh === original
      ? `"${original}"`
      : `"${effectiveCh}" (resolved from env var "${original}")`;
  return {
    kind: "messageBusProducerOrphan",
    boundary: producer.effect.binding,
    provider: makeSide(producer.summary, producer.transitionId),
    consumer: makeSide(producer.summary, producer.transitionId),
    description: `${producer.summary.identity.name} sends to ${semantics.messageBus} channel ${channelDisplay} but nothing in the analysed scope declares this channel, and no handler answers it. Likely cases: (a) the queue is declared in another stack we don't analyse (multi-repo); (b) work-in-progress before infra is wired up; (c) a real misconfiguration. Severity is warning rather than error because (a) and (b) are common false-positive sources.`,
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
  if (messageBus === "sns") {
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
  if (semantics.messageBus === "sns") {
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

interface ReceiveRecord {
  summary: BehavioralSummary;
  transitionId: string;
  fields: string[];
  effectCallee?: string;
}

/**
 * An opaque body on either side is skipped without a finding, so a
 * missing finding here does not mean the two sides agree.
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

    const producerFields = collectProducerFields(opts.producers, channel);
    if (producerFields === null) {
      continue;
    }

    for (const receive of receives) {
      for (const field of receive.fields) {
        if (producerFields.has(field)) {
          continue;
        }
        findings.push(
          makeBodyShapeFinding(cfnConsumer, semantics, receive, field),
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
          fields,
          ...(effect.callee !== undefined
            ? { effectCallee: effect.callee }
            : {}),
        });
      }
    }
  }
  return out;
}

/** Null when no producer on the channel has a body that can be compared. */
function collectProducerFields(
  producers: ProducerRecord[],
  channel: string,
): Set<string> | null {
  const out = new Set<string>();
  let anyExtractable = false;
  for (const producer of producers) {
    const producerChannel = effectiveChannel(producer);
    if (producerChannel === null || !channelsPair(producerChannel, channel)) {
      continue;
    }
    const body = producer.effect.interaction;
    if (body.class !== "message-send") {
      continue;
    }
    const fields = readObjectBodyFields(body.body);
    if (fields === null) {
      continue;
    }
    anyExtractable = true;
    for (const f of fields) {
      out.add(f);
    }
  }
  return anyExtractable ? out : null;
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
    description: `${receive.summary.identity.name} reads field "${missingField}" from a message on ${semantics.messageBus} channel "${semantics.channel}" but no producer in the analysed scope sends "${missingField}". Likely a producer/consumer drift: the producer renamed or removed the field, or the consumer expects a field that was never sent.`,
    severity: "warning",
  };
}
