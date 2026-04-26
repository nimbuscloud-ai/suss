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
- `messageBusPairing.ts:resolveProducerChannels` — maps env-var names (what the recognizer saw) to CFN logical ids via runtime-config metadata.
- `messageBusPairing.ts:checkBodyShapes` — field-set comparison between producer sends and consumer receives.

## Non-obvious things

- **Channel resolution is two-phase.** Producer code emits a `message-send` effect with `channel = ORDERS_QUEUE_URL` (the env-var name). Pairing first looks for an exact match against a declared queue's logical id; if that fails, runtime-config metadata (when in scope) maps the env-var to its declared resource id and pairing retries. Orphans are expected when neither resolves.
- **Body-shape comparison is opt-in by shape.** Only `kind = "object"` bodies (with extracted `fields`) get compared. Identifier-shaped args (`send(payload)` where payload is a variable), call-shaped args (`send(buildPayload())`), and absent bodies skip silently. False positives on opaque shapes are worse than missed findings.
- **Consumer code scope comes from metadata.** Consumer's `metadata.codeScope.kind === "codeUri"` (Lambda CodeUri or container path) determines which code summaries are in-scope for receive-side body extraction. Without scope, body-shape comparison can't run.
- **Platform-injected env vars are tagged.** AWS auto-injects `AWS_REGION`, `LAMBDA_TASK_ROOT`, etc. The runtime-config provider marks these as `source: "platform"` in `envVarSources`. The check uses this to suppress `envVarUnused` warnings for vars the platform set, even if no code reads them.

## Sibling modules

- `interactions/dispatcher.ts` — `providersOf` and `interactionsOf` are the lookup primitives.
- `runtime-config/runtimeConfigPairing.ts` — supplies the `envVarTargets` metadata for channel resolution.
