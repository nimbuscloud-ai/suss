# Proposal: the effect grammar

Status: draft, seeking alignment. No implementation yet.

## The problem, by example

Extract this handler today:

```typescript
export const placeOrder = async (event) => {
  const order = parseOrder(event.body);
  if (order.total > 0) {
    await client.send(new SendMessageCommand({
      QueueUrl: process.env.ORDERS_QUEUE_URL,
      MessageBody: JSON.stringify({ id: order.id, total: order.total }),
    }));
  }
  console.log("order received", order.id);
  fs.appendFileSync(auditPath, line);
  return { statusCode: 202, body: "{}" };
};
```

The summary records three side effects, each treated differently:

- The queue send is fully understood: it has a class (`message-send`),
  a channel (`ORDERS_QUEUE_URL`), a payload structure (`{id, total}`), and
  a condition (`order.total > 0`). It can pair against the consumer on
  the other side of the queue.
- The `console.log` is recorded as "a call to console.log with these
  arguments". No category, no channel. You can see it in inspect
  output, but you cannot ask "what does this unit write to".
- The `fs.appendFileSync` is the same: visible as a call, invisible as
  a capability.

The difference is not in the code. It is in whether a pack happened to
classify that kind of call. We have six categories (storage access,
HTTP calls, message send, message receive, config reads, scheduling),
each added when some pack needed it, each with its own field names.
There is no category for writing to stdout or the filesystem at all.

Replacing the grab-bag with one form that every side effect fits gives
"what does this code touch" a single answer, regardless of which pack
recognized it.

## The shape

Every effect becomes five things:

```
(family, verb, target, payload, conditions)
```

Read it as a sentence: this code **verb**s a **family** resource named
**target**, with **payload** in it, when **conditions** are true.

- **family**: what kind of resource. Six to start: `storage`,
  `network`, `message`, `config`, `io`, `time`. These are kinds of
  infrastructure, never framework names. There will never be an
  "express" or "prisma" family.
- **verb**: what is done to it. A small fixed set per family:
  read / write / delete for storage and io, call for network,
  send / receive for message, read for config, schedule for time.
- **target**: the specific thing touched (a table name, a host, a
  queue, an env-var name, `stdout`, a file path). When the analyzer
  cannot work the target out, it records `unresolved` with a reason.
  It never silently drops the effect. The unnamed-boundaries proposal
  spells this same state as null on today's binding identity fields.
  When pairing keys become targets, those nulls become `unresolved`
  with a reason, so the two documents state one rule.
- **payload**: the structure of the data crossing, in TypeShape (the
  same language for describing data that bodies and intent
  declarations already use), when we can extract it.
- **conditions**: the predicates on the transition the effect belongs
  to. These already exist, and the reason for calling them out here is
  that a capability is conditional: "sends to OrdersQueue **when total
  > 0**" is the whole fact.

The example handler, in the grammar:

```
(message, send,  OrdersQueue,   {id, total},  total > 0)
(io,      write, stdout,        text,         always)
(io,      write, <audit path>,  text,         always)
```

All three are now the same kind of fact. The first pairs against the
queue's consumer, exactly as today. The other two exist for the first
time.

Nothing about extraction changes. The six current categories map into
the grammar one-for-one (storage-access with kind read becomes
`(storage, read, table, fields)`, and so on down the list). Their
per-class extras (which fields a query touched, whether a config read
had a `??` default, whether a timer had a delay) move into
family-specific payload metadata. The io rows are the only new
extraction, and they are ordinary recognizers in the node runtime
pack.

## What it buys, in build order

1. **The vocabulary itself.** This is an additive IR change. Old
   summaries keep parsing, and the six classes are read as their
   grammar equivalents for one release.
2. **A capability view per unit.** Fold the effects of every
   transition together and you get "what this unit touches":

   ```
   placeOrder
     message send  OrdersQueue     when total > 0
     io      write stdout, <audit path>
   ```

   All of it comes from data we already have. You can query it ("which
   units write OrdersQueue"), and inspect renders it as a short block.
3. **Effect deltas in `inspect --diff`.** This is the one for the
   reviewer, especially for agent-written code: a PR's diff summary says
   "added: network call to api.example.com; added: config read of
   PAYMENT_KEY". You learn what a change *reaches*, without reading
   the diff line by line. This is the highest-value item in the arc
   and ships immediately after 2, since it only diffs capability
   views.
4. **Intent can declare effects.** The planned v0.2 intent format lets
   an outcome be an effect: "on success, the order is queued". A PRD
   scenario links to "the order was queued" instead of only to a
   status code. Same tuples, so nothing gets a second name.
5. **Compare against IAM policy.** Our manifest parsing already sees
   the role policy next to each Lambda. A capability view and an IAM
   policy are the same kind of statement (verb on a resource), so the
   checker can compare them both ways: code sends to a queue the role
   cannot reach, or the role grants a table nothing in the code
   touches. That is static least-privilege drift, from machinery we
   already have.
6. **Transitive closure, last.** Today an effect belongs to the
   function whose body performs it. A handler's true capability
   includes what its callees do. That is the existing access-tracing
   arc. It is the expensive part, and it blocks nothing above.

## Prior art, and what we take from each

We are not inventing this vocabulary, since forty years of work
already exists. The job is to take from it selectively:

- **Effect systems** (research languages like Koka; Java's checked
  exceptions are a primitive one). These languages track "what a
  function does" in its type: this function reads, writes, throws.
  We take the bookkeeping rules: effect lists compose when functions
  call each other, and a list with fewer entries satisfies a
  declaration that allows more. That gives intent checking its floor
  semantics for free. The difference is that those systems require you
  to write your code in their language, and their effects are abstract
  labels like "io". suss infers the list from code that never opted in,
  and its entries point at concrete infrastructure: not "io" but
  "writes OrdersQueue".
- **Capability systems** (the object-capability line of work). These
  answer "what MAY this code touch" and enforce it. We take the
  boundary lesson: suss describes what code DOES touch and stays out
  of the permission business. "Must not touch X" belongs in an intent
  document, checked like any other declaration, so the IR never has
  enforcement semantics in it.
- **Cloud IAM vocabularies** (AWS actions like `sqs:SendMessage` on a
  queue ARN). AWS already maintains a tested enumeration of every
  channel production code touches, written as verb-on-resource. We take
  the form of that taxonomy and the way it names targets, which is what
  makes item 5 (policy comparison) a mechanical join instead of a
  research project.
- **WASI and Deno permissions.** Both partition io as read/write per
  stream or path prefix. We take that partition as the form of the io
  family.

## Guardrails

- **The death test.** If a framework dying would ever force a family
  or verb change, framework vocabulary leaked into the grammar. Packs
  translate surface syntax into the grammar, and they never extend it.
- **Description, not permission.** The IR states what code does. May
  and must-not live in intent documents that reference the same
  tuples.
- **Unresolved is a value.** A target the analyzer cannot resolve is
  recorded with a reason and shows up in accounting. A capability view
  with unresolved entries says so, and it never silently narrows.
- **No new authoring surface.** Nobody annotates code. The grammar is
  extracted. The only hand-written artifacts are intent documents,
  and only if a team wants effect declarations.

## Migration

- Additive schema first: the new form lands beside the old classes,
  packs switch to emitting it, `parseSummaries` upgrades old documents
  on read.
- Pairing keys (message channel, config name, storage table) are
  unchanged. They become target values, so the checker rewrite is
  mechanical.
- The old classes leave the published JSON schema one release after
  every in-repo producer emits the new form.

## Open questions for alignment

1. Is HTTP its own family, or a `network` family with the protocol on
   the target (grpc and websocket will arrive eventually)?
   Recommendation: `network`, so new protocols are data, not schema.
2. Does `time`/schedule belong in the grammar even though it pairs
   with nothing? Recommendation: yes, since "schedules background
   work" is worth seeing in a capability view even without a partner
   to check against.
3. Do unclassified invocation effects (plain calls with the structure
   of their arguments) fold into the grammar, or stay beneath it as
   the raw material recognizers classify? Recommendation: stay beneath
   it, since a call is not a capability until something resolves what
   it touches.
4. How exact are targets? A queue name is exact. A URL could be a
   host, or a host plus a path prefix, and a file path could be a
   prefix. Recommendation: one target form per family: exact for
   message and config, host plus optional path prefix for network,
   path prefix for io.
