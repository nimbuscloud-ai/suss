# receive/

This module has one rule that every protocol shares. A receiver asks for a path off the value it received, and a sender supplies a shape. The rule reports the paths that no sender supplies.

suss already checked the reverse direction. A client's `expectedInput` records what it reads off a response, and `bodyCompatibility`, `consumerContract` and `responseMisread` check that against what the provider returns. The receiving direction was recorded on every summary as `inputReads`, but nothing compared it against anything except React props.

The rule lives in the IR package and not in one checker, because the behavioural checker and the intent checker both use it, and the intent checker does not depend on the behavioural one. `@suss/checker` re-exports it, so the passes there import it from the same place as before.

## What it takes and what it gives back

`readSetOf(summary, carriesPayload)` turns a summary's `inputReads` into a list of paths, or explains why the list would be too short to compare against. The protocol supplies `carriesPayload`, which picks the input that the sender's whole value arrives through: the `props` object for React, and the event parameter for a queue handler.

A read through that input gives the path from the payload's root, so `message.data.invoiceId` becomes `["data", "invoiceId"]`. A read through any other parameter puts that parameter's role first. So a React child that destructures `{ label }` gives `["label"]`, even when the binding was renamed.

`compareSupplied(reads, supplied)` walks each path into each sender's value and returns the paths nothing supplies. A sender's value is an `EffectArg`, the shape an adapter read off the call argument.

## When it declines to compare

A false finding against working code costs more than a missing one, so in each of these cases the rule reports nothing at all.

- **`no-reads`.** The summary recorded nothing under `inputReads`. Either the unit reads nothing off its input or the extractor could not follow it, and from here there is no way to tell which.
- **`rest-parameter`.** A rest binding collects whatever the caller passed. Code could consume anything through it without a read being recorded.
- **`payload-used-whole`.** The receiver used the payload object itself, with an empty path. It can forward the object anywhere, and any field of it could be read somewhere this summary cannot see.
- **`sender-opaque`.** One of the senders passed something other than an object literal, such as a variable or a call. It could be setting any of these paths. The message-bus pass used to ignore such a sender and compare against the rest, and it reported fields that a `send(payload)` beside them may well have been sending.
- **`platform-envelope`.** A queue handler read one of the fields at the top of the platform's own record (`Records` for SQS, `detail` for EventBridge), so it received the envelope and not the message. Its paths are not body fields, and comparing them against a producer's payload would report nonsense. The table of envelope fields is in `messageBodyReadSet`.
- **`unmapped-protocol`.** `boundaryInputReads` was called for a protocol that has not declared which input the caller's value arrives through. REST is the case that matters. A request is split across headers, query, path and body, and only the framework's vocabulary tells which of a handler's reads belongs to which part.
- **`different-object`.** Every path came back unsupplied, and the reads and the sender do not share a single outermost name. A receiver reading the platform's envelope looks like this. A raw SQS handler reads `event.Records` while the producer sends `{ id, total }`, and reporting `Records` as a missing field would be nonsense. This case applies only when `rootedAtPayload` is false, which means the protocol could not tell whether the parameter is the sender's value or an envelope around it. A destructure of an already-parsed message is known to start at the sender's value, so a wholesale rename there is reported.

`different-object` is the case that loses findings. A payload with a single top-level field that was renamed looks the same as a receiver reading the wrong object, and the rule stays quiet about both. A protocol that knows what its envelope looks like can set `rootedAtPayload` itself and not leave it to this rule. `messageBodyReadSet` does that for the buses Lambda delivers: a handler that reads none of the envelope's fields has the parsed message, and its top-level rename is reported.

## What the reader cannot see into

Inside a path, a value the adapter could not read is treated as supplying whatever is asked of it. `{ data: buildData() }` counts as supplying `data.invoiceId`, because the call could return it. Only a named field that is missing from an object literal counts as unsupplied.

An index in the middle of a read path is dropped and not recorded. So `event.Records[0].body` arrives as `["Records", "body"]`, which is a path that does not exist. Treating an array as opaque keeps that from turning into a finding, and the message-bus pass also leaves a handler that reads `Records` out of the comparison altogether.

## Who uses it

- The message-bus pass in `@suss/checker` compares what a queue consumer reads with what the producers on its channel send. It passes the rule two kinds of read. The destructured fields of a `message-receive` effect start at the parsed message. The `inputReads` of the code deployed as the consumer start at the handler parameter.
- The React render-props pass in `@suss/checker` uses `readSetOf` for the opposite question: which props a parent passes that the child never reads. It only needs the outermost segment of each path.
- `@suss/checker-intent` compares the read set against the `receives` block of a boundary intent doc. That block is a declaration, where the other users compare against another unit's call.

## Asking it by boundary

`boundaryInputReads(summary, binding)` picks the `carriesPayload` for the boundary's protocol, so a caller that already has a binding does not have to. A function-call boundary treats every parameter as part of what the caller sent, so a read comes back under that parameter's role. A message-bus boundary goes through `messageBodyReadSet`. Every other protocol declines with `unmapped-protocol`.

`carriesPayloadFor(binding)` returns the same predicate on its own, for a caller that needs the predicate and not the read set. It returns null for a protocol that has not declared one.

`readPathOf(summary, ref, carriesPayload)` writes a `ValueRef` as a path in the same form `readSetOf` uses for a read, so a guard on a value and a read of the same value line up. `suss infer intent` uses it to work out which declared field a rejecting branch tests.

## Not done here

REST is not handled. An HTTP receiver's read paths are split across three places the sender fills separately: path parameters, query string, and body. `event.pathParameters.invoiceId` and `req.body.invoiceId` refer to different parts of a request, and which part a first segment refers to is defined by the framework's vocabulary, which the checker does not have. Comparing them needs the packs to declare which of their input's fields is which part of a request, and that declaration does not exist yet.
