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
// Findings emitted (all v0 are wiring-shape findings, not value-add
// findings — see TODO below):
//   messageBusProducerOrphan       warning  code sends to channel X but no provider declares X
//   messageBusConsumerOrphan       warning  consumer Lambda exists for channel X but no producer sends to X
//   messageBusUnused               warning  channel X declared but no producer or consumer
//
// TODO (the actually valuable check): messageBusBodyShapeMismatch.
// The producer's interaction.body is an EffectArg shape; the
// consumer's expected shape can be derived from the handler's
// parameter type. Compare with `bodyShapesMatch` (already exists in
// `../body/bodyMatch.ts`). That comparison is what catches the
// expensive-to-debug runtime failures: producer field renamed and
// consumer doesn't read the new name; producer adds a required field
// and consumer crashes on the missing fallback. The wiring findings
// above are scaffolding to make sure pairing dispatch fires; the
// body-shape finding is the one that earns its keep.

import type {
  BehavioralSummary,
  BoundaryBinding,
  Effect,
  Finding,
  MessageBusSemantics,
} from "@suss/behavioral-ir";

type MessageSendInteraction = Extract<Effect, { type: "interaction" }> & {
  interaction: { class: "message-send" };
};

interface ProducerRecord {
  effect: MessageSendInteraction;
  summary: BehavioralSummary;
  transitionId: string;
  /**
   * Resolved CFN-channel after env-var → resource collapse, or null
   * when no chain-collapse mapping was found.
   */
  resolvedChannel: string | null;
}

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
export function checkMessageBus(summaries: BehavioralSummary[]): Finding[] {
  const findings: Finding[] = [];

  const queueProviders = summaries.filter(isQueueProvider);
  const consumers = summaries.filter(isQueueConsumer);
  const producers = collectProducers(summaries);

  // Build the env-var → CFN-channel mapping by walking runtime-config
  // providers' codeScope vs the producer effect's source file. For
  // each producer, find the runtime-config summary whose codeScope
  // contains the producer file; the env vars on that runtime are the
  // candidate channels. v0 simplification: trust direct name match.
  resolveProducerChannels(producers, summaries);

  const allChannels = new Set<string>();
  const providerChannels = new Set<string>();
  const consumerChannels = new Set<string>();
  const producerChannels = new Set<string>();

  for (const p of queueProviders) {
    const ch = channelOf(p);
    if (ch !== null) {
      providerChannels.add(ch);
      allChannels.add(ch);
    }
  }
  for (const c of consumers) {
    const ch = channelOf(c);
    if (ch !== null) {
      consumerChannels.add(ch);
      allChannels.add(ch);
    }
  }
  for (const p of producers) {
    const ch = effectiveChannel(p);
    if (ch !== null) {
      producerChannels.add(ch);
      allChannels.add(ch);
    }
  }

  // Producer with no provider → orphan producer.
  for (const p of producers) {
    const semantics = p.effect.binding.semantics;
    if (semantics.name !== "message-bus") {
      continue;
    }
    const ch = effectiveChannel(p);
    if (ch === null || providerChannels.has(ch)) {
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
    if (producerChannels.has(semantics.channel)) {
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
      producerChannels.has(semantics.channel) ||
      consumerChannels.has(semantics.channel)
    ) {
      continue;
    }
    findings.push(makeUnusedQueueFinding(p, semantics));
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Walkers
// ---------------------------------------------------------------------------

function isQueueProvider(s: BehavioralSummary): boolean {
  return (
    s.kind === "library" &&
    s.identity.boundaryBinding?.semantics.name === "message-bus"
  );
}

function isQueueConsumer(s: BehavioralSummary): boolean {
  return (
    s.kind === "consumer" &&
    s.identity.boundaryBinding?.semantics.name === "message-bus"
  );
}

function channelOf(s: BehavioralSummary): string | null {
  const sem = s.identity.boundaryBinding?.semantics;
  return sem?.name === "message-bus" ? sem.channel : null;
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

function collectProducers(summaries: BehavioralSummary[]): ProducerRecord[] {
  const out: ProducerRecord[] = [];
  for (const summary of summaries) {
    if (isQueueProvider(summary) || isQueueConsumer(summary)) {
      continue;
    }
    for (const transition of summary.transitions) {
      for (const effect of transition.effects) {
        if (effect.type !== "interaction") {
          continue;
        }
        if (effect.interaction.class !== "message-send") {
          continue;
        }
        if (effect.binding.semantics.name !== "message-bus") {
          continue;
        }
        out.push({
          effect: effect as MessageSendInteraction,
          summary,
          transitionId: transition.id,
          resolvedChannel: null,
        });
      }
    }
  }
  return out;
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
    const envVarName = semantics.channel;
    const runtime = findRuntimeForFile(
      runtimeProviders,
      producer.summary.location.file,
    );
    if (runtime === null) {
      continue;
    }
    const targets = readEnvVarTargets(runtime);
    const target = targets[envVarName];
    if (target !== undefined) {
      producer.resolvedChannel = target.logicalId;
    }
  }
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
