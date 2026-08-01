// messageBusPairing.ts — pair message-send interaction effects (from
// recognizers like @suss/framework-aws-sqs) against queue provider
// summaries (from @suss/contract-cloudformation), with a chain-collapse
// step to bridge env-var-named producer channels to CFN-resource-named
// queue channels.
//
// This is a v0 dispatcher-style implementation that consolidates into
// the unified pairing pass (#174) when other interaction classes
// migrate. Lives in its own directory for now to keep the message-bus
// finding generators self-contained.
//
// Findings emitted:
//   messageBusProducerOrphan       warning  code sends to channel X but no provider declares X
//   messageBusConsumerOrphan       warning  consumer Lambda exists for channel X but no producer sends to X
//   messageBusUnused               warning  channel X declared but no producer or consumer
//   unsupportedSemantics           info     an EventBridge rule's EventPattern couldn't be reduced
//                                           to exact detail-types (content filter / no detail-type);
//                                           the target Lambda is surfaced as unpaired-unresolvable
//   boundaryFieldUnknown (aspect: receive)
//                                  warning  consumer destructures field X from JSON.parse(record.body)
//                                           but no producer to this channel sends X
//
// Channels pair on their subject, with the bus required to agree only
// when both sides carry one; see channelPairing.ts for why.
//
// Body-shape pairing (the field-shape finding) joins producer
// `message-send` effects against consumer `message-receive` effects
// by channel. Producer-side bodies come from object-literal
// MessageBody calls (extracted as EffectArg by the SQS recognizer);
// consumer-side bodies come from destructuring patterns on
// `JSON.parse(record.body)` (extracted by the same pack's
// messageReceiveRecognizer). When either side's body is opaque
// (identifier args, dynamic builders, plain variable assignment),
// the comparison is skipped — absence of the finding doesn't imply
// agreement.

import {
  buildInteractionIndex,
  type InteractionIndex,
  type InteractionRecord,
  interactionsOf,
  providersOf,
} from "../interactions/dispatcher.js";
import {
  addChannel,
  type ChannelSet,
  channelsPair,
  createChannelSet,
  hasPair,
} from "./channelPairing.js";

import type {
  BehavioralSummary,
  BoundaryBinding,
  Finding,
  MessageBusSemantics,
} from "@suss/behavioral-ir";

type ProducerRecord = InteractionRecord<"message-send"> & {
  /**
   * Resolved CFN-channel after env-var → resource collapse, or null
   * when no chain-collapse mapping was found.
   */
  resolvedChannel: string | null;
};

/**
 * Pair message-bus consumers (CFN queue providers + Lambda consumer
 * summaries) against producer-side message-send interaction effects.
 *
 * Channel resolution: producer effects emit channel = env-var name
 * (the name the recognizer could see at extraction time, e.g.
 * "ORDERS_QUEUE_URL"). Provider summaries use channel = CFN logical
 * id (e.g. "OrdersQueue"). The bridge: each runtime-config provider
 * summary's metadata.runtimeContract.envVars knows which env vars
 * the Lambda has, but not the resolved targets (those would need to
 * be added in a future runtime-config extension). For v0, we collapse
 * via direct channel string match — works when the recognizer can be
 * configured to emit CFN-resource names directly, and works when env
 * var names happen to match queue logical ids (a common convention).
 *
 * Future improvement: extend runtime-config provider metadata to
 * carry envVarTargets so the chain-collapse can resolve
 * "ORDERS_QUEUE_URL" → "OrdersQueue" via the producer Lambda's
 * Environment block.
 */
export function checkMessageBus(
  summaries: BehavioralSummary[],
  index?: InteractionIndex,
): Finding[] {
  const findings: Finding[] = [];
  const idx = index ?? buildInteractionIndex(summaries);

  // Both queue providers (kind=library) and Lambda consumer summaries
  // (kind=consumer) live under message-bus semantics. Filter by kind
  // to split them.
  const messageBusSummaries = providersOf(idx, "message-bus");
  const queueProviders = messageBusSummaries.filter(
    (s) => s.kind === "library",
  );
  const allConsumers = messageBusSummaries.filter((s) => s.kind === "consumer");
  // EventBridge rules whose pattern couldn't be reduced to exact
  // detail-types, and scheduled invocations, carry a patternResolution
  // marker. Unresolvable rules surface as an info finding (never
  // silent); scheduled invocations are accounted for by their summary's
  // presence and exempt from producer/consumer pairing (a schedule has
  // no message producer by design). Everything else pairs normally.
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

  // Build the env-var → CFN-channel mapping by walking runtime-config
  // providers' codeScope vs the producer effect's source file. For
  // each producer, find the runtime-config summary whose codeScope
  // contains the producer file; the env vars on that runtime are the
  // candidate channels. v0 simplification: trust direct name match.
  resolveProducerChannels(producers, summaries);

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
    // A subject-channelled SQS consumer still drains a concrete queue.
    // The CFN contract keeps that queue's logical id in metadata so the
    // queue is not mis-reported as unused.
    const queue = consumedQueueOf(c);
    if (queue !== null) {
      addChannel(consumerChannels, queue);
    }
  }
  for (const p of producers) {
    const ch = effectiveChannel(p);
    if (ch !== null) {
      addChannel(producerChannels, ch);
    }
  }

  // Producer with no provider → orphan producer.
  for (const p of producers) {
    const semantics = p.effect.binding.semantics;
    if (semantics.name !== "message-bus") {
      continue;
    }
    const ch = effectiveChannel(p);
    if (ch === null || hasPair(providerChannels, ch)) {
      continue;
    }
    findings.push(makeOrphanProducerFinding(p, semantics, ch));
  }

  // Consumer with no producer → orphan consumer (warning, not error
  // — the Lambda might be feature-flagged off, or the producer might
  // be in a different repo we don't analyse).
  for (const c of consumers) {
    const semantics = c.identity.boundaryBinding?.semantics;
    if (semantics?.name !== "message-bus") {
      continue;
    }
    if (hasPair(producerChannels, semantics.channel)) {
      continue;
    }
    findings.push(makeOrphanConsumerFinding(c, semantics));
  }

  // Queue declared but no producer AND no consumer → unused.
  for (const p of queueProviders) {
    const semantics = p.identity.boundaryBinding?.semantics;
    if (semantics?.name !== "message-bus") {
      continue;
    }
    if (
      hasPair(producerChannels, semantics.channel) ||
      hasPair(consumerChannels, semantics.channel)
    ) {
      continue;
    }
    findings.push(makeUnusedQueueFinding(p, semantics));
  }

  // Body-shape pairing: for each channel that has both producer
  // (sends) and consumer (receives), compare field sets and emit
  // findings for fields the consumer reads but the producer
  // doesn't send.
  findings.push(...checkBodyShapes(consumers, producers, summaries));

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
 * drains, or null when the consumer's channel already names the queue.
 */
function consumedQueueOf(s: BehavioralSummary): string | null {
  const meta = s.metadata as { messageBus?: { queue?: unknown } } | undefined;
  const queue = meta?.messageBus?.queue;
  return typeof queue === "string" ? queue : null;
}

/**
 * Effective channel after env-var → CFN-resource resolution. Producers
 * emit channel = env-var name; if the chain-collapse resolved it to
 * a CFN logical id, prefer that for pairing — otherwise fall back to
 * the recognizer's original channel string. Pairing against providers
 * (CFN-resource-named) succeeds only on the resolved form; falling
 * back to the env-var name surfaces the orphan-producer finding,
 * which is the right behaviour when chain-collapse fails.
 */
function effectiveChannel(p: ProducerRecord): string | null {
  if (p.resolvedChannel !== null) {
    return p.resolvedChannel;
  }
  const sem = p.effect.binding.semantics;
  return sem.name === "message-bus" ? sem.channel : null;
}

/**
 * Resolve env-var-named channels to CFN-resource-named channels.
 *
 * Producer effects emit `channel = env-var name` (the only thing the
 * recognizer can see at extraction time, e.g. "ORDERS_QUEUE_URL").
 * Provider summaries use `channel = CFN logical id` (e.g. "OrdersQueue").
 *
 * The bridge: each runtime-config provider summary carries
 * `metadata.runtimeContract.envVarTargets`, a map from env-var name
 * to the CFN resource the var Refs. For each producer, find the
 * runtime-config provider whose codeScope contains the producer's
 * file, look up the env-var name in envVarTargets, and stash the
 * resolved CFN id on the producer record.
 *
 * Producers whose env var doesn't resolve (no runtime-config in
 * scope, or env var has a plain-string value) keep their original
 * env-var-named channel. Pairing then naturally falls through to
 * "orphan producer" since no provider declares an env-var-named
 * channel.
 */
function resolveProducerChannels(
  producers: ProducerRecord[],
  summaries: BehavioralSummary[],
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
    // SQS keys the whole channel on the env-var name. EventBridge keys
    // it on `${bus}#${detailType}`, where only the bus segment is env-
    // derived — split it off, resolve the bus, recompose with the
    // detail-type intact.
    const { busToken, detailSuffix } = splitBusChannel(semantics);
    const runtime = findRuntimeForFile(
      runtimeProviders,
      producer.summary.location.file,
    );
    if (runtime === null) {
      continue;
    }
    const targets = readEnvVarTargets(runtime);
    const target = targets[busToken];
    if (target !== undefined) {
      producer.resolvedChannel =
        detailSuffix !== null
          ? `${target.logicalId}#${detailSuffix}`
          : target.logicalId;
    }
  }
}

/**
 * Split a message-bus channel into the env-resolvable bus token and an
 * optional detail suffix. SQS channels are a single token (the whole
 * channel is the bus / queue identity). EventBridge channels are
 * `${bus}#${detailType}` — only the bus segment resolves via the
 * env-var chain-collapse, so it's split out and the detail-type is
 * recomposed after resolution.
 */
function splitBusChannel(semantics: MessageBusSemantics): {
  busToken: string;
  detailSuffix: string | null;
} {
  if (semantics.messageBus === "eventbridge") {
    const hash = semantics.channel.indexOf("#");
    if (hash !== -1) {
      return {
        busToken: semantics.channel.slice(0, hash),
        detailSuffix: semantics.channel.slice(hash + 1),
      };
    }
  }
  return { busToken: semantics.channel, detailSuffix: null };
}

/**
 * Read the EventBridge pattern-resolution marker off a CFN consumer
 * summary. Present only on EventBridge consumers: "schedule" for time-
 * triggered invocations, "unresolvable" for rules whose EventPattern
 * couldn't be reduced to exact detail-types, "exact" for reduced rules.
 * Absent (null) on SQS consumers and any summary without the marker.
 */
function readPatternResolution(
  summary: BehavioralSummary,
): "exact" | "schedule" | "unresolvable" | null {
  const meta = summary.metadata as
    | { messageBus?: { patternResolution?: unknown } }
    | undefined;
  const resolution = meta?.messageBus?.patternResolution;
  if (
    resolution === "exact" ||
    resolution === "schedule" ||
    resolution === "unresolvable"
  ) {
    return resolution;
  }
  return null;
}

function findRuntimeForFile(
  runtimes: BehavioralSummary[],
  filePath: string,
): BehavioralSummary | null {
  for (const runtime of runtimes) {
    const meta = runtime.metadata as
      | { codeScope?: { kind?: string; path?: string } }
      | undefined;
    const scope = meta?.codeScope;
    if (scope?.kind !== "codeUri" || scope.path === undefined) {
      continue;
    }
    if (filePath.startsWith(scope.path)) {
      return runtime;
    }
  }
  return null;
}

function readEnvVarTargets(
  runtime: BehavioralSummary,
): Record<string, { kind: "ref"; logicalId: string }> {
  const meta = runtime.metadata as
    | {
        runtimeContract?: {
          envVarTargets?: Record<string, { kind: "ref"; logicalId: string }>;
        };
      }
    | undefined;
  return meta?.runtimeContract?.envVarTargets ?? {};
}

// ---------------------------------------------------------------------------
// Finding builders
// ---------------------------------------------------------------------------

function makeOrphanProducerFinding(
  producer: ProducerRecord,
  semantics: MessageBusSemantics,
  effectiveCh: string,
): Finding {
  // Note the channel difference (recognizer's env-var name vs the
  // CFN id we tried to resolve to) so users can debug whether the
  // failure is in chain-collapse or in the missing provider.
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
    description: `${producer.summary.identity.name} sends to ${semantics.messageBus} channel ${channelDisplay} but no provider in the analysed scope declares this channel. Likely cases: (a) the queue is declared in another stack we don't analyse (multi-repo); (b) work-in-progress before infra is wired up; (c) a real misconfiguration. Severity is warning rather than error because (a) and (b) are common false-positive sources.`,
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
): Finding {
  const binding = provider.identity.boundaryBinding as BoundaryBinding;
  return {
    kind: "messageBusUnused",
    boundary: binding,
    provider: makeSide(provider),
    consumer: makeSide(provider),
    description: `${semantics.messageBus} channel "${semantics.channel}" is declared in infrastructure but neither produced to nor consumed from. Likely orphan resource left over from a removed feature.`,
    severity: "warning",
  };
}

/**
 * An EventBridge rule whose EventPattern couldn't be reduced to exact
 * detail-types (no detail-type field, content filters, etc.). v0 pairs
 * on exact detail-type match only, so this rule's target can't be
 * matched to producers. Surfaced as info rather than dropped — the
 * target might well be wired correctly; suss just can't verify the
 * pattern subsumption.
 */
function makeUnresolvableRuleFinding(consumer: BehavioralSummary): Finding {
  const binding = consumer.identity.boundaryBinding as BoundaryBinding;
  const meta = consumer.metadata as
    | {
        messageBus?: {
          rule?: unknown;
          eventBus?: unknown;
          unresolvableReason?: unknown;
        };
      }
    | undefined;
  const rule =
    typeof meta?.messageBus?.rule === "string"
      ? meta.messageBus.rule
      : consumer.identity.name;
  const eventBus =
    typeof meta?.messageBus?.eventBus === "string"
      ? meta.messageBus.eventBus
      : "default";
  const reason =
    typeof meta?.messageBus?.unresolvableReason === "string"
      ? meta.messageBus.unresolvableReason
      : "the EventPattern couldn't be reduced to exact detail-types";
  return {
    kind: "unsupportedSemantics",
    boundary: binding,
    provider: makeSide(consumer),
    consumer: makeSide(consumer),
    description: `EventBridge rule "${rule}" on bus "${eventBus}" routes to ${consumer.identity.name}, but ${reason}. v0 pairs producers to rules on exact detail-type match, so this rule can't be paired — it's surfaced as unpaired-unresolvable rather than dropped. Pattern subsumption (prefix / content-based filtering) is out of scope for now.`,
    severity: "info",
  };
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
    summary: `${summary.location.file}::${summary.identity.name}`,
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
 * For each CFN consumer summary with a known channel + codeScope,
 * find every code summary scoped under that path that emits
 * `interaction(class: "message-receive")` effects with object-shaped
 * bodies. Compare each receive-side field set against the producer's
 * send-side field sets for the same channel. Emit
 * `boundaryFieldUnknown` (aspect: receive) for fields the consumer
 * reads but no producer sends.
 *
 * Skipped silently when either side's body is opaque (call-shaped,
 * identifier-shaped, or absent) — we'd be guessing, and a false
 * positive on body shape is worse than a missed finding.
 */
function checkBodyShapes(
  cfnConsumers: BehavioralSummary[],
  producers: ProducerRecord[],
  allSummaries: BehavioralSummary[],
): Finding[] {
  const findings: Finding[] = [];
  for (const cfnConsumer of cfnConsumers) {
    const semantics = cfnConsumer.identity.boundaryBinding?.semantics;
    if (semantics?.name !== "message-bus") {
      continue;
    }
    const channel = semantics.channel;
    const codeScope = readCodeScope(cfnConsumer);
    if (codeScope === null) {
      continue;
    }

    const receives = collectReceives(allSummaries, codeScope);
    if (receives.length === 0) {
      continue;
    }

    const producerFields = collectProducerFields(producers, channel);
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
  codeScopePath: string,
): ReceiveRecord[] {
  const out: ReceiveRecord[] = [];
  for (const summary of summaries) {
    if (!summary.location.file.includes(codeScopePath)) {
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

/**
 * Collect the union of field names emitted by all producers targeting
 * the given channel. Returns null when no producer has an extractable
 * (object-shaped) body — at that point we can't usefully compare.
 */
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

/**
 * Read the field-name set out of an EffectArg shape, but only when
 * the body is object-shaped (`{ kind: "object", fields: { ... } }`).
 * Returns null for any other shape (string literal, identifier, call,
 * absent) — those are opaque to v0 body-shape comparison.
 */
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
    description: `${receive.summary.identity.name} reads field "${missingField}" from a message on ${semantics.messageBus} channel "${semantics.channel}" but no producer in the analysed scope sends "${missingField}". Likely a producer/consumer drift — the producer renamed or removed the field, or the consumer expects a field that was never sent.`,
    severity: "warning",
  };
}
