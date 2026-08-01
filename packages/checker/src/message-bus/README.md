# message-bus/

Pairs queue and topic providers (CloudFormation / SAM / similar) against producer code (sending messages) and consumer code (receiving messages). Resolves env-var-named channels to declared resource ids and checks body-shape compatibility between sender and receiver.

## Place in the pipeline

Runs in `checkAll()` after pairing. Consumes:
- Queue providers (`kind = library`, `message-bus` semantics) from contract sources.
- Lambda consumers (`kind = consumer`, `message-bus` semantics) — the recipients.
- Producer code with `message-send` interaction effects (sending into the queue).
- Runtime-config providers carrying `envVarTargets` metadata for channel resolution.
- Code summaries scoped under each consumer's CodeUri.

Emits `messageBusProducerOrphan`, `messageBusConsumerOrphan`, `messageBusUnused`, and `boundaryFieldUnknown` (aspect: receive) findings.

## Key files

- `messageBusPairing.ts:checkMessageBus` — main orchestrator.
- `channelPairing.ts` holds the channel index (`ChannelSet`, `addChannel`, `hasPair`). The split and the pairing rule themselves are `parseChannel` and `channelsPair` in `@suss/ir-core`, re-exported here, because `boundaryKey` builds the pairing key from the same split.
- `messageBusPairing.ts:resolveProducerChannels` — maps env-var names (what the recognizer saw) to CFN logical ids via runtime-config metadata.
- `messageBusPairing.ts:checkBodyShapes` — field-set comparison between producer sends and consumer receives.

## Non-obvious things

- **Channels pair on the subject; the bus has to agree only when both sides name one.** A channel is written `${bus}#${subject}`, and the bus segment is optional. The template names both (`default#order.placed`), so two buses routing the same detail-type stay apart. A handler's code names only the subject it expects (`order.placed`), because which bus reaches it is deployment configuration, so a bus-less channel pairs with that subject on any bus. Queue-id channels (`OrdersQueue`) carry no separator and pair by equality as before.
- **This pass owns every message-bus finding; the generic pairing pass owns the pair list.** `boundaryKey` gives a message-bus binding a key, so `suss check` now reports which handler answers a declared subscriber. Those pairs skip `checkPair`, and message-bus summaries that paired with nothing are kept out of the unmatched lists, because `messageBusUnused` and the orphan findings here already say it with a severity.
- **Channel resolution is two-phase.** Producer code emits a `message-send` effect with `channel = ORDERS_QUEUE_URL` (the env-var name). Pairing first looks for an exact match against a declared queue's logical id; if that fails, runtime-config metadata (when in scope) maps the env-var to its declared resource id and pairing retries. Orphans are expected when neither resolves.
- **Body-shape comparison is opt-in by shape.** Only `kind = "object"` bodies (with extracted `fields`) get compared. Identifier-shaped args (`send(payload)` where payload is a variable), call-shaped args (`send(buildPayload())`), and absent bodies skip silently. False positives on opaque shapes are worse than missed findings.
- **Consumer code scope comes from metadata.** Consumer's `metadata.codeScope.kind === "codeUri"` (Lambda CodeUri or container path) determines which code summaries are in-scope for receive-side body extraction. Without scope, body-shape comparison can't run.
- **Platform-injected env vars are tagged.** AWS auto-injects `AWS_REGION`, `LAMBDA_TASK_ROOT`, etc. The runtime-config provider marks these as `source: "platform"` in `envVarSources`. The check uses this to suppress `envVarUnused` warnings for vars the platform set, even if no code reads them.

## Sibling modules

- `interactions/dispatcher.ts` — `providersOf` and `interactionsOf` are the lookup primitives.
- `runtime-config/runtimeConfigPairing.ts` — supplies the `envVarTargets` metadata for channel resolution.
