# receive/

One rule, shared by every protocol: a receiver asks for a path off the value it was handed, a sender supplies a shape, and the rule reports the paths no sender supplies.

suss already did the mirror image of this. A client's `expectedInput` says what it reads off a response, and `bodyCompatibility`, `consumerContract` and `responseMisread` check that against what the provider returns. The receiving direction was recorded on every summary as `inputReads` and never compared against anything except React props.

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
- **`different-object`.** Every path came back unsupplied and not one outermost name is shared. That is what a receiver reading the platform's envelope looks like: a raw SQS handler reads `event.Records` while the producer sends `{ id, total }`, and reporting `Records` as a missing field would be nonsense. This one applies only to reads that start at a handler parameter. A destructure of an already-parsed message is known to start at the sender's value, so a wholesale rename there is reported.

`different-object` is the one that costs findings. A payload with a single top-level field, renamed, looks exactly like a receiver reading the wrong object, and the rule keeps quiet about both.

## What the reader cannot see into

Inside a path, a value the adapter could not read is treated as supplying whatever is asked of it. `{ data: buildData() }` counts as supplying `data.invoiceId`, because the call could return it. Only a named field that is missing from an object literal counts as unsupplied.

An index in the middle of a read path is dropped rather than recorded: `event.Records[0].body` arrives as `["Records", "body"]`, which is not a path that exists. Treating an array as opaque keeps that from turning into a finding, and `different-object` catches the envelope case it usually comes from.

## Who uses it

- `message-bus/messageBusPairing.ts` compares what a queue consumer reads against what the producers on its channel send. It feeds the rule two kinds of read: the destructured fields of a `message-receive` effect, which start at the parsed message, and the `inputReads` of the code deployed as the consumer, which start at the handler parameter.
- `render/renderProps.ts` uses `readSetOf` for the opposite question, which props a parent passes that the child never reads. It only needs the outermost segment of each path.

## Not done here

REST. An HTTP receiver's read paths are split across three places the sender fills separately: path parameters, query string, and body. `event.pathParameters.invoiceId` and `req.body.invoiceId` name different halves of a request, and which half a first segment refers to is the framework's vocabulary, not the checker's. Comparing them needs the packs to say which of their input's fields is which part of a request, and that declaration does not exist yet.
