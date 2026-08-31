# @suss/intent-ir

The team-authored side of the loop: what the code was *meant* to do, in a form that pairs against the derived `BehavioralSummary` of what it *does*.

## What this package is

Two citizens, discriminated by `kind`, both built on `@suss/ir-core` so intent and behaviour describe boundaries the same way:

- **System intent** (`kind: boundary`): what one boundary should do, as named outcomes. The boundary is REST, function-call, message-bus or storage, and every field of one comes off the `@suss/ir-core` schema for that protocol.
- **Outcome intent** (`kind: prd`): human `when` / `expect` scenarios, each with an optional `link` to a system-intent outcome (`<intent-name>.<outcome-id>`). A scenario with no `link` is a valid state to be in: it reads fully, and nothing has linked it to an outcome yet.

## What an outcome is

A transition says three things: what it turned on, how it ends, and what it did.

**What it turned on**: `when`, a list of clauses in the same verbs `results` uses.

```yaml
transitions:
  - id: invoice-not-found
    when:
      - reads: aws.dynamodb:Invoices
        finds: nothing
    response:
      status: 404

  - id: invoice-settled
    when:
      - reads: aws.dynamodb:Invoices
        finds: something
        where: settledAt is set
    response:
      status: 409

  - id: invoice-returned
    when:
      - reads: aws.dynamodb:Invoices
        finds: something
        where: settledAt is missing
    response:
      status: 200
    results:
      - reads: aws.dynamodb:Invoices
        by: invoiceId
```

A clause says which subject, then at most one thing about it.

The subject is a boundary verb (`reads`, `writes`) whose value is the boundary's name, or `input:` with the path the caller sent. Those come from the IR's own subject types: a guard on the result of a call that crossed a boundary becomes the boundary form, one on an input becomes `input:`, and anything else falls back.

The check is one of `finds` (`nothing` or `something`, what a lookup came back with), `is` (`set`, `missing`, `null`, `a string`), `equals`, or `has`. `where` narrows the clause with whatever the guard said about a deeper read of the same result.

A fall-through branch states its own condition rather than pointing at the ones above it, since the summary records that branch's guards as the negations of theirs. `otherwise` is left for the one case that has none to state, which is a default branch the summary recorded nothing for. A word that means "not the branches above" would change what it claims the moment somebody inserts a transition over it, in a file people hand-edit.

A guard that maps to none of this keeps a sentence, and `when` written as one plain string stays valid, which is what existing authored documents use.

The point of naming the boundary is that the line survives a rename of the variable the source used, and that the checker can compare it. `when: "!doc.send().Item"` could do neither.

**How it ends**: at most one of `response` (a status and a body), `returns` (a function or handler return value), or `throws` (an error).

**What it did**: `results`, a list of the effects the outcome has, written in the verbs `suss ask` asks with.

```yaml
transitions:
  - id: invoice-recorded
    when: the message gives an invoice id we have not recorded
    returns:
      body:
        properties:
          recorded: { type: boolean }
    results:
      - writes: aws.dynamodb:Invoices
```

`suss ask "what writes aws.dynamodb:Invoices"` is the question and this is the assertion, spelled the same way. The key is the verb, `reads` or `writes`, which are the two `relationsOf` in `@suss/behavioral-ir` gives an effect. The value is the boundary's own name, the string every report writes and `namesBoundary` in `@suss/ir-core` resolves, so what you type in a document and what you type at `ask` pick out the same boundary. Nothing here is per protocol, so a queue consumer and a table writer say what they do without a fourth outcome shape each.

A clause can go further, since the summary does. `fields` is the columns the access touches and `by` is what it picks the item out by:

```yaml
    results:
      - reads: aws.dynamodb:Accounts
        by: accountId
      - writes: aws.dynamodb:Profiles
        fields: [email, phone, address]
```

Both are optional and a clause with only the verb and the name means what it always did. What they buy is that "the customer's contact details are erased" stops being satisfied by any write at all to that table. The checker asks that the access cover every column the clause stated; an access that states none is unread rather than empty (no pack parses a DynamoDB `UpdateExpression`), and one that asked for every column covers whatever the clause stated.

The outcome id stays free-form on purpose. That is where a person writes what the outcome means, and it is what a PRD scenario links to: `invoice-intake.invoice-recorded`, read as "a duplicate delivery changes nothing". A `kind: prd` document is the level where a scenario reads as prose; `kind: boundary` is system intent for engineers, so it stays structural.

Adding `results` changes nothing about `response`, `returns` and `throws`. A doc that states only those parses and pairs the way it always did.

## Which boundaries pair, and which are pending

A boundary intent pairs when its boundary has a key. REST has one from its method and path, a function-call export has one from its package and export path, and a message-bus boundary has one from its channel.

A store has none. `storage.ts` in `@suss/ir-core` returns null for a storage identity key on purpose: a container name can be a pattern with holes that only a caller or the deployment settles, and the storage pass in `@suss/checker` grounds it before pairing. So a `kind: boundary` doc whose boundary is a store is authorable, and the checker reports it as `unkeyableBoundary` and puts it in `unchecked` rather than pretending to have compared it. That is the same pending state a module-level function-call boundary is in.

What does pair today is a store named as the target of an effect: put `- writes: aws.dynamodb:Invoices` on an outcome of the boundary that touches the store, and the checker compares it against the storage accesses on that boundary's transitions.

Every boundary kind has a name of its own in `@suss/ir-core`, `storageLabel` being the one this change added, so an effect always takes a label and never a structured block. A binding with no name at all, a REST call whose method and path the code never settles, is left out of a draft rather than written as a string nobody would type back.

```ts
import { IntentDocSchema, intentDocToSummary } from "@suss/intent-ir";

const doc = IntentDocSchema.parse(/* parsed YAML / JSON */);
const summary = intentDocToSummary(doc); // normalised, checker-ready
```

`schema.ts` is the authoring surface (friendly to write); `summary.ts` is the normalized form the checker consumes (boundaries as `ir-core` `BoundaryBinding`s, bodies as `TypeShape`s, one flat outcome list) plus the transform between them. `source` provenance (`author` / `inferred` / `inferred, curated`) travels along with it for the inference path.

The design is documented in [`design/proposals/intent-specs.md`](../../design/proposals/intent-specs.md).

## Where it fits in suss

It is a peer of `@suss/behavioral-ir`; both build on `@suss/ir-core`. Readers (e.g. `@suss/contract-intent`) parse files into `IntentDoc` and call `intentDocToSummary`; the checker pairs the result against derived code summaries.

## Status

v0: REST, function-call, message-bus and storage system intent, effects as outcomes, PRD outcome intent with optional links. GraphQL, runtime-config and metric boundaries have no block yet.

## Coverage

![coverage](../../.github/badges/coverage-intent-ir.svg)

## License

Apache-2.0
