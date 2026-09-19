# receive/

One rule, shared by every protocol: a receiver asks for a path off the value it was handed, a sender supplies a shape, and the rule reports the paths no sender supplies.

suss already did the mirror image of this. A client's `expectedInput` says what it reads off a response, and `bodyCompatibility`, `consumerContract` and `responseMisread` check that against what the provider returns. The receiving direction was recorded on every summary as `inputReads` and never compared against anything except React props.

The rule lives in the IR package rather than in one checker because the behavioural checker and the intent checker both ask it, and the intent checker does not depend on the behavioural one. `@suss/checker` re-exports it, so the passes there import it from where it has always been.

## What it takes and what it gives back

`readSetOf(summary, carriesPayload)` turns a summary's `inputReads` into a list of paths, or says why the list would be too short to compare against. The protocol supplies `carriesPayload`, which says which input the sender's whole value arrives through: the `props` object for React, the event parameter for a queue handler.

A read through that input gives the path from the payload's root, so `message.data.invoiceId` becomes `["data", "invoiceId"]`. A read through any other parameter gives that parameter's role first, so a React child that destructures `{ label }` gives `["label"]` even when the binding was renamed.

`compareSupplied(reads, supplied)` walks each path into each sender's value and returns the ones nothing supplies. A sender's value is an `EffectArg`, the shape an adapter read off the call argument.

## When it declines to compare

A false finding against working code costs more than a missing one, so the rule reports nothing at all in each of these.

- **`no-reads`.** The summary recorded nothing under `inputReads`. Either the unit reads nothing off its input or the extractor could not follow it, and those two are indistinguishable from here.
- **`rest-parameter`.** A rest binding collects whatever the caller passed. Anything could be consumed through it without a read being recorded.
- **`payload-used-whole`.** The receiver used the payload object itself, with an empty path. It can forward the object anywhere, and every field of it could be read somewhere this summary cannot see.
- **`sender-opaque`.** One of the senders passed something that is not an object literal: a variable, a call, a template string. It could be setting any of these paths. The message-bus pass previously ignored such a sender and compared against the rest, which reported a field a `send(payload)` beside it may well have been sending.
- **`platform-envelope`.** A queue handler read one of the fields at the top of the platform's own record (`Records` for SQS, `detail` for EventBridge), so it was handed the envelope rather than the message. Its paths are not body fields, and comparing them against a producer's payload would report nonsense. `messageBodyReadSet` is where that table lives.
- **`unmapped-protocol`.** `boundaryInputReads` was asked for a protocol that has not said which input the caller's value arrives through. REST is the one that matters: a request is split across headers, query, path and body, and which of a handler's reads is which part is the framework's vocabulary.
- **`different-object`.** Every path came back unsupplied and not one outermost name is shared. That is what a receiver reading the platform's envelope looks like: a raw SQS handler reads `event.Records` while the producer sends `{ id, total }`, and reporting `Records` as a missing field would be nonsense. This one applies only when `rootedAtPayload` is false, which is a read set whose protocol could not say whether the parameter is the sender's value or an envelope around it. A destructure of an already-parsed message is known to start at the sender's value, so a wholesale rename there is reported.

`different-object` is the one that costs findings. A payload with a single top-level field, renamed, looks exactly like a receiver reading the wrong object, and the rule keeps quiet about both. A protocol that knows what its envelope looks like can settle `rootedAtPayload` itself instead of leaving it to this rule, which is what `messageBodyReadSet` does for the buses Lambda delivers: a handler reading none of the envelope's fields has the parsed message, and its top-level rename is reported.

## What the reader cannot see into

Inside a path, a value the adapter could not read is treated as supplying whatever is asked of it. `{ data: buildData() }` counts as supplying `data.invoiceId`, because the call could return it. Only a named field that is missing from an object literal counts as unsupplied.

An index in the middle of a read path is dropped rather than recorded: `event.Records[0].body` arrives as `["Records", "body"]`, which is not a path that exists. Treating an array as opaque keeps that from turning into a finding, and the message-bus pass keeps a handler reading `Records` out of the comparison altogether.

## Who uses it

- The message-bus pass in `@suss/checker` compares what a queue consumer reads against what the producers on its channel send. It feeds the rule two kinds of read: the destructured fields of a `message-receive` effect, which start at the parsed message, and the `inputReads` of the code deployed as the consumer, which start at the handler parameter.
- The React render-props pass in `@suss/checker` uses `readSetOf` for the opposite question, which props a parent passes that the child never reads. It only needs the outermost segment of each path.
- `@suss/checker-intent` compares the read set against the `receives` block of a boundary intent doc, which is a declaration rather than another unit's call.

## Asking it by boundary

`boundaryInputReads(summary, binding)` picks the `carriesPayload` for the boundary's protocol so a caller with a binding to hand does not have to. A function-call boundary treats every parameter as part of what the caller sent, so a read comes back under that parameter's role. A message-bus boundary goes through `messageBodyReadSet`. Every other protocol declines with `unmapped-protocol`.

`carriesPayloadFor(binding)` gives the same answer on its own, for a caller that needs the predicate rather than the read set, and null for a protocol that has not said.

`readPathOf(summary, ref, carriesPayload)` spells a `ValueRef` the way `readSetOf` spells a read, so a guard on a value and a read of the same value line up. `suss infer intent` uses it to tell which declared field a rejecting branch tests.

## Not done here

REST. An HTTP receiver's read paths are split across three places the sender fills separately: path parameters, query string, and body. `event.pathParameters.invoiceId` and `req.body.invoiceId` name different halves of a request, and which half a first segment refers to is the framework's vocabulary, not the checker's. Comparing them needs the packs to say which of their input's fields is which part of a request, and that declaration does not exist yet.
