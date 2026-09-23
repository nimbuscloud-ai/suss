# Proposal: the encoding a payload is written in

Status: draft, seeking alignment. Nothing here is built.

## What a summary records today

A boundary binding records which wire a message travels over. It
records nothing about the form the bytes take on that wire:

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
place that can see how the payload is encoded either drops that fact or
peels it away.

The OpenAPI reader has it. `chosenContent` picks a media type by name
and returns only the schema:

```ts
const json = mediaTypes.find(
  (type) => type === "application/json" || type.endsWith("+json"),
);
const chosen = json ?? [...mediaTypes].sort()[0];
return chosen === undefined ? undefined : content[chosen];
```

Preferring JSON over whatever the document happened to list first fixed
the worst reading of a multi-format operation. It does not fix an
operation that offers no JSON at all. An
`application/x-www-form-urlencoded` request body becomes a request-body
input with a shape, a JSON client is compared against that shape, and
the two are reported as agreeing.

On the code side, two peels drop the same fact. `unwrapJsonStringify`
exists twice, once over `EffectArg` in the extractor's pack helpers:

```ts
if (candidate.kind !== "call" || candidate.callee !== "JSON.stringify") {
  return body;
}
const inner = candidate.args?.[0];
return inner ?? body;
```

and once over ts-morph nodes in the TypeScript adapter's terminal
reader. Both return what went into the call and keep no record of the
call they removed. The Lambda pack asks for the peel by name:

```ts
body: { from: "property", name: "body", unwrapJsonStringify: true },
```

The message packs do the same at the send site. `aws-eventbridge`
declares the payload as the `Detail` property, which its own example
writes as `Detail: JSON.stringify(order)`, and `aws-sqs` declares it as
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

In each of these places, one side states how the payload is written,
and the summary keeps only what was inside.

## The field

`encoding` goes where the shape goes: on an input next to `shape`, on a
`response` output next to `body`, on an `emit` output next to
`payload`. It does not go on the binding.

It stays away from `transport` for two reasons. One HTTP boundary can
take a form-urlencoded request and return a JSON response, so a single
string per boundary cannot state both. And an SQS record's body is
encoded inside an envelope that `transport` already describes, so
putting the encoding there would make one field mean two things.

The value is an array, innermost first. The shape's own encoding is at
index 0, and the last entry is what goes on the wire. A single encoding
is a one-element array. The members are `json`, `formUrlencoded`,
`multipart`, `xml`, `text`, `base64` and `gzip`. Base64 over JSON is
`["json", "base64"]`. A payload encoded twice is `["json", "json"]`.
That case is why the field is an array and not a single name: comparing
two arrays catches double encoding, and no separate rule is needed.

An absent field means unknown, and the enum gets no `unknown` member.
Absence already means "nobody said" everywhere else in the IR. An enum
member would make every pack that does not handle encoding yet write a
claim it never made.

Three sources declare it, and each already has the fact:

- A spec: the media type key `chosenContent` picks by name. The Lambda
  proxy envelope counts too, since a pack asking for
  `unwrapJsonStringify` is stating that the runtime puts a serialized
  string in the `body` slot.
- A header a client sets: `Content-Type` on a request, `Accept` on a
  response. The Express pack already lists `type` and `contentType`
  among the response methods that leave the sent value unchanged, so
  the walk reaches the header and throws away its value.
- An inline encode call the walk reads: `JSON.stringify` at a producer
  and `JSON.parse` at a consumer. Both `unwrapJsonStringify` copies
  find this call and then discard it.

Where a declared media type and an inline call at one site disagree,
the code's encoding is recorded, because the code is what runs. The
disagreement is itself a finding.

## The vocabulary each adapter supplies

`JSON.stringify` is ECMAScript, `json.dumps` is the Python standard
library, and `to_json` comes with Ruby. None of the three is runtime
behavior, so the names go in the adapter with the rest of the language
spec. A framework or runtime pack is the wrong place for them. Each
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
  receiver instead of from an argument, and the table records which of
  the two each name takes.

A language defines each of these, and no library does, so
`check:vocabulary` expects them in an adapter. The encoding members are
suss's own grammar and go in `packages/extractor/vocabulary.json` with
the other IR tags.

Today the three languages differ on the reading side. The Python
adapter's `shapeOfReturned` does not handle a call node, so it falls
through:

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
returned value at all today, so for Ruby the work is that reader plus
the table.

## What the checker reports

There is no new finding kind. `boundaryShapeMismatch` already describes
this, in the catalog's own words: both sides declare the value and
disagree about its form, type, nullability, content type. It has one
emitter, `checkMetric`, and nothing has ever emitted the content-type
part of that description. Encoding becomes the second emitter, and the
catalog entry gains the case.

It makes three comparisons:

- A producer writing JSON to a form-urlencoded operation. One finding,
  aspect `send`, and the description gives both encodings.
- A consumer whose `Accept` no producer satisfies. One finding, aspect
  `receive`. The path exists and the representation does not. That is a
  disagreement about form, and the route is there, so
  `restMethodOnUnknownPath` is the wrong kind for it.
- A payload encoded twice. `["json", "json"]` against a declared
  `["json"]`, reported by the same array comparison as the first case.

When either side does not record an encoding, nothing is reported. An
absent field is not a claim. Treating it as one would report every
boundary from a pack that does not handle encoding yet.
`metadata.http.statusRange` is the field whose two halves never met.
Staying silent on absence keeps this field clear of the opposite
failure, where a reader treats saying nothing as saying something.

## Envelopes stay a separate concept

An SQS record's body could be written as `["json", "sqsRecord"]`, one
stack running from the payload out to the wire. That would be a
mistake.

An envelope contributes identity and delivery: which channel, how many
times, which record in a batch. `transport` already records which wire
it is. The SQS pack finds the body structurally, through the `for` loop
over `event.Records`, and does not read an encoder to find it. Folding
the envelope into the stack puts a routing fact into a vocabulary about
form. It also makes one JSON payload compare unequal to itself,
depending on which wire it arrived over.

The two meet at one point. An envelope slot typed as a string means
something was encoded into it, the same claim `unwrapJsonStringify: true`
makes today. The envelope records that an encoding happened, and the
encoding field records which one.

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
`json.dumps(payload)`. Its response records the payload's shape and
`["json"]`, where today it never reports a body. #387 asks for a Python
Lambda, and that is a separate change. `framework-aws-lambda` declares
`languages: ["typescript", "javascript"]`, so a SAM template never
reaches a Python handler today, and recording encodings does not change
that.

`fixtures/ruby-rails` gets an action writing
`render plain: payload.to_json`, which records the payload's shape and
`["json"]`. It goes next to an existing `render json: payload`, which
records the same encoding from the pack's declaration instead of from a
call.

## Cost

`SUMMARY_SCHEMA_VERSION` goes to 7. Nothing is rewritten on the way in.
An older summary has no encoding field anywhere, a missing field means
unknown, and unknown reports nothing. The bump records the new meaning,
the way version 3 recorded a null `role`.

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
3. The comparison in the checker and the catalog entry. Users see
   nothing until this step, and it ships with the fixture counts above.
4. Headers. `Content-Type` on a call and `Accept` on a consumer are the
   only source that needs a new reader, and steps 1 through 3 work
   without them.
