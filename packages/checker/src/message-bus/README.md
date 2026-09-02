# message-bus/

This check pairs queue and topic providers (CloudFormation / SAM / similar) against producer code (the code that sends messages) and consumer code (the code that receives them). It resolves channels written as env-var names to declared resource ids, and it checks that the sender's and the receiver's body shapes are compatible.

## Place in the pipeline

`checkAll()` runs it after pairing. It takes:
- Queue providers (`kind = library`, `message-bus` semantics) from contract sources.
- Lambda consumers (`kind = consumer`, `message-bus` semantics), the recipients.
- Producer code with `message-send` interaction effects (the code sending into the queue).
- Runtime-config providers with `envVarTargets` metadata, used to resolve channels.
- Code summaries scoped under each consumer's CodeUri.

It emits `messageBusProducerOrphan`, `messageBusConsumerOrphan`, `messageBusUnused`, `messageBusConsumerDisabled`, and `boundaryFieldUnknown` (aspect: receive) findings.

## Key files

- `messageBusPairing.ts:checkMessageBus` is the main orchestrator.
- `channelPairing.ts` contains the channel index (`ChannelSet`, `addChannel`, `hasPair`). The split itself and the pairing rule are `parseChannel` and `channelsPair` in `@suss/ir-core`, re-exported here, because `boundaryKey` builds the pairing key from the same split.
- `messageBusPairing.ts:resolveProducerChannels` maps env-var names (what the recognizer saw) to CFN logical ids through runtime-config metadata.
- `messageBusPairing.ts:checkBodyShapes` compares what a consumer reads off a message against what the producers on that channel send. The comparison itself is `receive/inputContract.ts`, which React props go through too.

## Non-obvious things

- **Channels pair on the subject; the bus has to agree only when both sides give one.** A channel is written `${bus}#${subject}`, and the bus segment is optional. A template gives both (`default#order.placed`), so two buses routing the same detail-type stay apart. A handler's code gives only the subject it expects (`order.placed`), because which bus reaches it is decided by deployment configuration, so a channel with no bus pairs with that subject on any bus. Queue-id channels (`OrdersQueue`) have no separator and pair by equality, as before.
- **This pass owns every message-bus finding; the generic pairing pass owns the pair list.** `boundaryKey` gives a message-bus binding a key, so `suss check` now reports which handler matches a declared subscriber. Those pairs skip `checkPair`, and message-bus summaries that paired with nothing stay out of the unmatched lists, because `messageBusUnused` and the orphan findings here already report it with a severity.
- **Channel resolution is two-phase.** Producer code emits a `message-send` effect with `channel = ORDERS_QUEUE_URL` (the env-var name). Pairing first looks for an exact match against a declared queue's logical id. If that fails, runtime-config metadata (when it is in scope) maps the env-var to its declared resource id, and pairing tries again. When neither one resolves, an orphan is what you should expect.
- **The consumer's reads come from two places, and the destructure wins.** A `message-receive` effect says which fields the code pulled out of the parsed body, and those start at what the producer wrote. Where a consumer has none, the handler's own `inputReads` are used instead, which is how a consumer whose framework or factory parsed the message for it gets compared at all. Reads from `inputReads` are paths rather than names, so `data.invoiceId` is reported at that depth.
- **The handler's parameter is the envelope or the message, and its reads say which.** A wrapper that parses each record hands the handler the producer's object, and a raw handler gets the event Lambda built around it. The summary records both as the parameter with role `event`. What separates them is that Lambda's event has a fixed set of top-level fields per bus (`Records` for SQS, SNS and S3; `detail` and its siblings for EventBridge), and `LAMBDA_ENVELOPE_FIELDS` lists them. A handler that reads any of those has the envelope and is not compared. One that reads none of them has the message, so its reads start at what the producer wrote and a renamed top-level field is reported, the same as a renamed nested one. A bus with no entry in the table falls back to the shared-outermost-name rule in `receive/README.md`.
- **Body-shape comparison is opt-in by shape.** Only `kind = "object"` bodies (the ones with extracted `fields`) get compared, and one producer on the channel whose body is a bare identifier (`send(payload)`), a call (`send(buildPayload())`), or missing takes the whole channel out of the comparison. It could be sending anything, so a finding against the producers beside it would be a guess. False positives on bodies we cannot see into are worse than findings we miss. `receive/README.md` lists the rest.
- **A disabled subscription is treated as absent (#460).** A rule deployed `State: DISABLED` invokes nothing, so the pass reads `metadata.messageBus.enabled` and takes the subscription out of pairing entirely: it gets one `messageBusConsumerDisabled` info finding, it is never a consumer orphan, it does not answer a producer or keep a channel off the unused list, and its handler's bodies are not compared. The check is channel-wise: a second, enabled rule routing the same channel keeps the channel active. A rule routing only to a queue has no consumer summary for `enabled` to land on, so its provider stays active.
- **Consumer code scope comes from metadata.** The consumer's `metadata.codeScope.kind === "codeUri"` (a Lambda CodeUri or a container path) decides which code summaries are in scope for extracting the receive-side body. Without a scope, the body-shape comparison can't run.
- **Platform-injected env vars are tagged.** AWS injects `AWS_REGION`, `LAMBDA_TASK_ROOT`, and others by itself. The runtime-config provider marks these as `source: "platform"` in `envVarSources`, and the check uses that to suppress `envVarUnused` warnings for variables the platform set, even when no code reads them.

## Sibling modules

- `interactions/dispatcher.ts` provides `providersOf` and `interactionsOf`, the lookup primitives.
- `runtime-config/runtimeConfigPairing.ts` supplies the `envVarTargets` metadata used to resolve channels.
