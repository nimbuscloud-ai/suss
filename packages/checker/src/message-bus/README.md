# message-bus/

This check pairs queue and topic providers (CloudFormation / SAM / similar) with producer code, which sends messages, and consumer code, which receives them. It resolves channels written as env-var names to declared resource ids, and it checks that the sender's and the receiver's body shapes are compatible.

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
- `channelPairing.ts` contains the channel index (`ChannelSet`, `addChannel`, `hasPair`). The channel split and the pairing rule are `parseChannel` and `channelsPair` in `@suss/ir-core`, re-exported here, because `boundaryKey` builds the pairing key from the same split.
- `messageBusPairing.ts:resolveProducerChannels` maps env-var names (what the recognizer saw) to CFN logical ids through runtime-config metadata.
- `messageBusPairing.ts:checkBodyShapes` compares what a consumer reads off a message with what the producers on that channel send. The comparison itself lives in `receive/inputContract.ts`, which React props go through too.

## Gotchas

- **Channels pair on the subject, and the bus has to agree only when both sides give one.** A channel is written `${bus}#${subject}`, and the bus segment is optional. A template gives both (`default#order.placed`), so two buses routing the same detail-type stay apart. A handler's code gives only the subject it expects (`order.placed`), because deployment configuration decides which bus reaches it. A channel with no bus therefore pairs with that subject on any bus. Queue-id channels (`OrdersQueue`) have no separator and pair by equality, as before.
- **This pass makes every message-bus finding, and the generic pairing pass builds the pair list.** `boundaryKey` gives a message-bus binding a key, so `suss check` now reports which handler matches a declared subscriber. Those pairs skip `checkPair`. Message-bus summaries that paired with nothing stay out of the unmatched lists, because `messageBusUnused` and the orphan findings here already report them with a severity.
- **Channel resolution has two steps.** Producer code emits a `message-send` effect with `channel = ORDERS_QUEUE_URL` (the env-var name). Pairing first looks for an exact match against a declared queue's logical id. If that fails and runtime-config metadata is in scope, the metadata maps the env var to its declared resource id, and pairing tries again. When neither step resolves the channel, expect an orphan.
- **The consumer's reads come from two places, and the destructure wins.** A `message-receive` effect lists which fields the code pulled out of the parsed body, and those paths start at what the producer wrote. When a consumer has no such effect, the check uses the handler's own `inputReads`. That fallback is what lets a consumer be compared at all when its framework or factory parsed the message for it. Reads from `inputReads` are full paths, so `data.invoiceId` is reported at that depth.
- **The handler's parameter is either the envelope or the message, and its reads show which.** A wrapper that parses each record passes the handler the producer's object. A raw handler gets the event Lambda built around it. The summary records both as the parameter with role `event`. The way to tell them apart is that Lambda's event has a fixed set of top-level fields per bus, and `LAMBDA_ENVELOPE_FIELDS` lists them: `Records` for SQS, SNS and S3, and `detail`, `detail-type`, `resources`, `account` and `region` for EventBridge. EventBridge's `id`, `source` and `time` are left out of the table on purpose, because a parsed detail often has fields spelled that way, and listing them would drop such a handler from the comparison. A handler that reads any of the listed fields has the envelope and is not compared. A handler that reads none of them has the message, so its reads start at what the producer wrote, and a renamed top-level field is reported the same as a renamed nested one. A bus with no entry in the table falls back to the shared-outermost-name rule in `receive/README.md`.
- **Only object bodies are compared.** Only `kind = "object"` bodies (the ones with extracted `fields`) get compared. If any producer on the channel sends a bare identifier (`send(payload)`), a call (`send(buildPayload())`), or no body, the whole channel is left out of the comparison. That producer could be sending anything, so a finding against the producers beside it would be a guess. A false positive on a body the checker cannot see into costs more than a missed finding. `receive/README.md` lists the rest.
- **A disabled subscription is treated as absent (#460).** A rule deployed with `State: DISABLED` invokes nothing. The pass reads `metadata.messageBus.enabled` and takes the subscription out of pairing entirely. It gets one `messageBusConsumerDisabled` info finding and is never a consumer orphan. It does not count as a receiver for a producer, it does not keep a channel off the unused list, and its handler's bodies are not compared. The check works per channel, so a second, enabled rule routing the same channel keeps the channel active. A rule that routes only to a queue has no consumer summary to put `enabled` on, so its provider stays active.
- **Consumer code scope comes from metadata.** The consumer's `metadata.codeScope.kind === "codeUri"` (a Lambda CodeUri or a container path) decides which code summaries are in scope for extracting the receive-side body. Without a scope, the body-shape comparison can't run.
- **Platform-injected env vars are tagged.** AWS injects `AWS_REGION`, `LAMBDA_TASK_ROOT`, and others by itself. The runtime-config provider marks these as `source: "platform"` in `envVarSources`. The check uses that tag to suppress `envVarUnused` warnings for variables the platform set, even when no code reads them.

## Sibling modules

- `interactions/dispatcher.ts` provides `providersOf` and `interactionsOf`, the lookup primitives.
- `runtime-config/runtimeConfigPairing.ts` supplies the `envVarTargets` metadata used to resolve channels.
