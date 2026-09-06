# Proposal: the encoding a payload is written in

Status: draft, seeking alignment. Nothing here is built.

## What a summary records today

A boundary binding says which wire a message travels over, and nothing
about the form the bytes take on it:

```ts
export const BoundaryBindingSchema = z.object({
  transport: z.string(),
  semantics: SemanticsSchema,
  recognition: z.string(),
});
```

`transport` is `"http"`, `"aws_sqs"`, `"postgresql"`, `"in-process"`,
`"os"`. Next to it, an input has a `TypeShape` and nothing else, and so
does a `response` output's body and an `emit` output's payload. Every
place that knows how the payload is encoded either drops that fact or
peels it away.

The OpenAPI reader knows it. `chosenContent` picks a media type by name
and hands back only the schema:

```ts
const json = mediaTypes.find(
  (type) => type === "application/json" || type.endsWith("+json"),
);
const chosen = json ?? [...mediaTypes].sort()[0];
return chosen === undefined ? undefined : content[chosen];
```

Preferring JSON over whatever the document happened to list first fixed
the worst reading of a multi-format operation. What it does not fix is
an operation that does not offer JSON at all. An
`application/x-www-form-urlencoded` request body becomes a request-body
input with a shape, a JSON client is compared against that shape, and
the two are reported as agreeing.

Two peels drop the same fact on the code side. `unwrapJsonStringify`
exists twice, once over `EffectArg` in the extractor's pack helpers:

```ts
if (candidate.kind !== "call" || candidate.callee !== "JSON.stringify") {
  return body;
}
const inner = candidate.args?.[0];
return inner ?? body;
```

and once over ts-morph nodes in the TypeScript adapter's terminal
reader. Both return what went into the call and say nothing about the
call they removed. The Lambda pack asks for the peel by name:

```ts
body: { from: "property", name: "body", unwrapJsonStringify: true },
```

The message packs do the same at the send site. `aws-eventbridge` says
the payload is the `Detail` property, which its own example writes as
`Detail: JSON.stringify(order)`, and `aws-sqs` says the payload is
`MessageBody`. On the receive side the SQS recognizer fires only on a
`JSON.parse(record.body)` inside a `for (const record of event.Records)`
loop, so the JSON hop gates the match instead of becoming a fact in the
summary. The Ruby pack peels a library wrapper the same way:

```ts
argumentWrapping: {
  ancestorClassName: "GraphQL::Schema::RelayClassicMutation",
  argumentName: "input",
  extraFields: { clientMutationId: { type: { type: "text" }, required: false } },
}
```

Each of these is a place where one side states how the payload is
written and the summary keeps only what was inside.

## The field

`encoding` goes where the shape goes, not on the binding: on an input
next to `shape`, on a `response` output next to `body`, on an `emit`
output next to `payload`.

Two reasons it does not go next to `transport`. One HTTP boundary can
take a form-urlencoded request and return a JSON response, so a single
string per boundary cannot state both. And an SQS record's body is
encoded inside an envelope that `transport` already describes, so
putting the encoding there makes one field say two things.

The value is an array, innermost first. The shape's own encoding is at
index 0, and the last entry is what goes on the wire. A single encoding
is a one-element array. The members are `json`, `formUrlencoded`,
`multipart`, `xml`, `text`, `base64` and `gzip`. Base64 over JSON is
`["json", "base64"]`. A payload encoded twice is `["json", "json"]`,
which is why the field is an array rather than a name: double encoding
falls out of comparing two arrays and does not need a rule of its own.

Unknown is the absent field. The enum does not get an `unknown` member.
Absence already means "nobody said" everywhere else in the IR, and an
enum member would make every pack that has not been taught encoding
write a claim it never made.

Three sources declare it, and each already has the fact in hand:

- A spec. The media type key `chosenContent` picks by name, and the
  Lambda proxy envelope, where a pack asking for `unwrapJsonStringify`
  is the runtime saying that the `body` slot is a serialized string.
- A header a client sets: `Content-Type` on a request, `Accept` on a
  response. The Express pack already lists `type` and `contentType`
  among the response methods that leave the sent value unchanged, so
  the walk reaches the header and drops what it says.
- An inline encode call the walk reads: `JSON.stringify` at a producer
  and `JSON.parse` at a consumer, which is what both
  `unwrapJsonStringify` copies find before discarding it.

Where a declared media type and an inline call at one site disagree,
the code is what runs, so the code's encoding is recorded and the
disagreement is itself a finding.

## The vocabulary each adapter supplies

`JSON.stringify` is ECMAScript, `json.dumps` is the Python standard
library, and `to_json` comes with Ruby. None of the three is runtime
behavior, so the names belong to the adapter along with the rest of the
language spec, rather than to a framework or runtime pack. Each
adapter's pack surface gets one table:

```ts
encodings: Array<{
  encoding: PayloadEncoding;
  encode: string[];
  decode: string[];
}>;
```

- TypeScript: `JSON.stringify` encodes and `JSON.parse` decodes. Both
  spellings are in the adapter already, one in the terminal reader and
  one in the SQS recognizer's gate.
- Python: `json.dumps` encodes and `json.loads` decodes.
- Ruby: `to_json` and `JSON.generate` encode, `JSON.parse` decodes.
  `to_json` is a method on the payload, so its shape comes from the
  receiver rather than from an argument, and the table says which of
  the two each name takes.

A language defines each of these, rather than a library, so putting
them in an adapter is what `check:vocabulary` asks for. The encoding
members are suss's own grammar and go in
`packages/extractor/vocabulary.json` with the other IR tags.

The reading side is where the three languages are unequal today. The
Python adapter's `shapeOfReturned` does not handle a call node, so it
falls through:

```ts
if (node.type === "identifier" || node.type === "attribute") {
  return { type: "ref", name: node.text };
}

return { type: "unknown" };
```

and `returnedBodyShape` turns that unknown into null. A Python handler
returning `json.dumps(payload)` never reports a body, where the
TypeScript one reports the payload's shape. With the table, a call whose
callee is a declared encode name reads through to its argument and
records `["json"]` next to the shape. Ruby does not read the shape of a
returned value at all today, so its half is that reader and the table
together.

## What the checker reports

No new finding kind. `boundaryShapeMismatch` already describes this, in
the catalog's own words: both sides declare the value and disagree about
its form, type, nullability, content type. It has one emitter,
`checkMetric`, and the content-type half of that sentence has never been
true of anything. Encoding is the second emitter, and the catalog entry
gets the case.

Three comparisons:

- A producer writing JSON to a form-urlencoded operation. One finding,
  aspect `send`, and the description gives both encodings.
- A consumer whose `Accept` no producer satisfies. One finding, aspect
  `receive`. The path exists and the representation does not, which is
  a disagreement about form rather than a missing route, so
  `restMethodOnUnknownPath` is the wrong kind for it.
- A payload encoded twice. `["json", "json"]` against a declared
  `["json"]`, reported by the same array comparison as the first case.

When either side does not record an encoding, nothing is reported. An
absent field is not a claim, and treating it as one would report every
boundary belonging to a pack that has not been taught encoding.
`metadata.http.statusRange` is the field whose two halves never met;
staying silent on absence is how this one avoids the opposite failure,
a reader that treats saying nothing as saying something.

## Envelopes stay a separate concept

An SQS record's body could be written as `["json", "sqsRecord"]`, one
stack running from the payload out to the wire. That is the wrong call.

An envelope contributes identity and delivery: which channel, how many
times, which record in a batch. `transport` already says which wire it
is, and the SQS pack finds the body structurally, through the `for` loop
over `event.Records`, rather than by reading an encoder. Folding the
envelope into the stack puts a routing fact into a vocabulary about
form, and it makes one JSON payload compare unequal to itself depending
on which wire it arrived over.

The two meet at one point. An envelope slot typed as a string says that
something was encoded into it, which is what `unwrapJsonStringify: true`
says today: the envelope says an encoding happened, and the encoding
field says which one.

## Acceptance

`fixtures/payload-encoding` contains a spec and its clients:

- An operation listing `application/xml` above `application/json`,
  called by a JSON client. The request-body input records `["json"]`,
  the client records `["json"]`, and nothing is reported. This is the
  regression guard on `chosenContent`.
- An operation offering only `application/x-www-form-urlencoded`,
  called by the same JSON client. One `boundaryShapeMismatch`, aspect
  `send`, giving `formUrlencoded` and `json`.
- A producer writing `JSON.stringify(JSON.stringify(payload))` to an
  operation declaring JSON. One finding, `["json", "json"]` against
  `["json"]`.
- A producer and an operation where neither states an encoding.
  Nothing is reported.

`fixtures/python-fastapi/shop` gets a handler returning
`json.dumps(payload)`, whose response records the payload's shape and
`["json"]` where today it never reports a body. #387 asks for a Python
Lambda, and that is a separate change: `framework-aws-lambda` declares
`languages: ["typescript", "javascript"]`, so a SAM template never
reaches a Python handler today, and recording encodings does not turn
that on.

`fixtures/ruby-rails` gets an action writing
`render plain: payload.to_json`, which records the payload's shape and
`["json"]`, next to an existing `render json: payload`, which records
the same encoding from the pack's declaration instead of from a call.

## Cost

`SUMMARY_SCHEMA_VERSION` goes to 7. Nothing is rewritten on the way in,
because an older summary does not have the field anywhere, that reads
as unknown, and unknown is silent. The bump marks the meaning, the way
version 3 marked a null `role`.

What changes: `behavioral-ir` for the field and the version,
`contract-openapi` to return the media type `chosenContent` already
picks, `extractor` and `adapter-typescript` so the two peels report what
they removed, `adapter-python` and `adapter-ruby` for the encoding table
and the shape reading that follows an encode call,
`framework-aws-lambda`, `framework-aws-sqs` and
`framework-aws-eventbridge` to state that their body slot is encoded,
and `checker` for the comparison.

## Order

1. The field, the schema bump, and every writer that has the fact
   already: the OpenAPI media type, the two peels, and the three
   envelope packs. Nothing is compared yet, so nothing a user sees
   changes.
2. The three adapters' encoding tables, with the Python and Ruby
   reading that turns an encode call into a shape. All three go in one
   step, so no release announces a feature only TypeScript has.
3. The comparison in the checker and the catalog entry. This is the
   step that makes any of it visible, and it ships with the fixture
   counts above.
4. Headers. `Content-Type` on a call and `Accept` on a consumer are the
   only source that needs reading built for it, and steps 1 through 3
   work without them.
