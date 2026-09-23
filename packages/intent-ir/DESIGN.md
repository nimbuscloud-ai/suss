# What an intent document states

The reference for `@suss/intent-ir`: what an outcome is made of, and which boundaries pair against code. The [README](./README.md) says what the package is for.

## What an outcome is

A transition states three things: the condition it turned on, how it ends, and what it did.

**What it turned on**: `when`, a list of clauses written in the same verbs `results` uses.

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

A clause gives a subject, then at most one check on it.

The subject is either a boundary verb (`reads`, `writes`) whose value is the boundary's name, or `input:` with the path the caller sent. Both come from the IR's own subject types. A guard on the result of a call that crossed a boundary becomes the boundary form, a guard on an input becomes `input:`, and anything else falls back.

The check is one of `finds` (`nothing` or `something`, meaning what a lookup came back with), `is` (`set`, `missing`, `null`, `a string`), `equals`, or `has`. `where` narrows the clause with whatever the guard said about a deeper read of the same result.

A fall-through branch states its own condition. It does not point at the branches above it, because the summary records that branch's guards as the negations of theirs. `otherwise` is kept for the one case with no condition to state: a default branch the summary recorded nothing for. A word meaning "not the branches above" would change what it claims as soon as somebody inserts a transition above it, and people edit these files by hand.

A guard that maps to none of this keeps a sentence. A `when` written as one plain string stays valid, since existing authored documents write it that way.

Writing the boundary's name means the line survives a rename of the variable the source used, and the checker can compare it. `when: "!doc.send().Item"` allows neither.

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

`suss ask "what writes aws.dynamodb:Invoices"` asks the question, and this line asserts the answer, spelled the same way. The key is the verb: `reads`, `writes` or `invokes`, the three relations `relationsOf` in `@suss/behavioral-ir` gives an effect. The value is the boundary's own name. Every report writes that string and `namesBoundary` in `@suss/ir-core` resolves it, so what you type in a document and what you type at `ask` pick out the same boundary. None of this is specific to a protocol. A queue consumer and a table writer describe what they do in the same verbs, and neither needs an outcome format of its own.

`invokes` is the verb for calling a deployed unit by name, which is how a service built out of Lambdas fits together:

```yaml
    results:
      - invokes: unit:lambda ArchiveWorker
```

A run that reads the deployment template gives a unit its name, so the boundary a document declares is `unit:lambda ReportBuilder`. The callee on a `results` line is spelled the same way, even when the code that invokes it reaches it through an env var. `deploymentOf` in `@suss/behavioral-ir` looks up which resource the template points that variable at. The drafter and the intent checker both go through it, so a document gives the function and not the variable. A run with no template in it has no function name to put in. Then the line keeps the code's own spelling, `unit:lambda {ARCHIVE_WORKER_FUNCTION}`, and the document's header lists the variable it is waiting on. A store the code reaches through a variable works the same way.

A clause can say more, because the summary records more. `fields` lists the columns the access touches, and `by` gives what it picks the item out by:

```yaml
    results:
      - reads: aws.dynamodb:Accounts
        by: accountId
      - writes: aws.dynamodb:Profiles
        fields: [email, phone, address]
```

Both are optional, and a clause with only the verb and the name means what it always did. With them, "the customer's contact details are erased" is no longer satisfied by any write at all to that table. The checker requires the access to cover every column the clause stated. An access that states no columns counts as unread, and the checker does not treat it as empty, since no pack parses a DynamoDB `UpdateExpression`. An access that asked for every column covers whatever the clause stated.

The outcome id stays free-form on purpose. A person writes what the outcome means there, and a PRD scenario links to it: `invoice-intake.invoice-recorded`, meaning "a duplicate delivery changes nothing". A `kind: prd` document is where a scenario is written as prose. `kind: boundary` is system intent for engineers, so it stays structural.

Adding `results` changes nothing about `response`, `returns` and `throws`. A doc that states only those parses and pairs the way it always did.

## What a boundary receives

A `receives` block lists the fields of the value the boundary is handed. A function-call boundary writes its arguments by parameter name, and a dot reaches inside one:

```yaml
boundary:
  semantics: function-call
  package: "@suss/checker"
  exportPath: ["checkPair"]
  receives:
    provider: { type: object, required: true }
    consumer: { type: object, required: true }
```

A message-bus boundary lists the fields of the message body the same way. A REST boundary has a section for each part of the request, because a sender fills the four parts separately:

```yaml
boundary:
  semantics: rest
  method: POST
  path: /invoices/:id/settle
  receives:
    headers:
      x-tenant-id: { type: string, required: true }
    query:
      dryRun: { type: boolean }
    body:
      type: object
      properties:
        note: { type: string }
```

Listing a field is a complete declaration on its own, so `x-tenant-id: { required: true }` and a bare `orderId: {}` both give a check something to use. `required` defaults to false. Inside a `receives` field, `required` is the boolean "the boundary needs this field". The same word on an object shape, as a list of property names, still works for nested properties.

The block lists only the fields the author wants checked. It does not describe the whole input, so a field the code reads that the block leaves out is reported at info and no higher. A document with no `receives` block makes no claim about the input, the same way a document with no `results` makes no claim about effects.

Every spelling normalises to the same list on `BoundaryIntentSummary.receives`. Each entry has a path, a shape or null, and whether the field is required. `pair.provider` becomes `["pair", "provider"]`, and a REST section becomes the first segment of the path, giving `["headers", "x-tenant-id"]` and `["body", "note"]`. The checker makes one pass over that list and does not look at the boundary kind.

Reaching those paths from a REST handler takes one more step, and that step is outside this package. A handler reads a header at `request.headers` under Express and at `event.headers` under an AWS Lambda proxy integration. So each pack declares where its handlers read the four parts, the adapter stamps that on every route it recognizes, and `@suss/behavioral-ir` rewrites a read into the section an author wrote. Header names compare case-insensitively.

Every boundary block is a `z.strictObject`, so a misspelt `recieves:` stops the run with `boundary: Unrecognized key: "recieves"` instead of disappearing. The boundary intent document, the PRD document, a boundary's transition and a PRD scenario are strict objects too, so `scenario:` for `scenarios:`, `respones:` on a transition and `titel:` on a scenario each stop the run. Only unknown keys are rejected. The fields that were optional stay optional, so a module-level function-call boundary can still be authored and `source:` can still be left off.

## Which boundaries pair, and which are pending

A boundary intent pairs when its boundary has a key. REST gets one from its method and path. A function-call export gets one from its package and export path. A message-bus boundary gets one from its channel. An invoked unit gets one from its deployment target and the name the platform knows it by. A unit whose name only the runtime settles has no key, so a document for one can be authored and is reported as `unkeyableBoundary`.

A store has no key either. `storage.ts` in `@suss/ir-core` returns null for a storage identity key on purpose. A container name can be a pattern with holes that only a caller or the deployment settles, and the storage pass in `@suss/checker` grounds it before pairing. So a `kind: boundary` doc whose boundary is a store can be authored. The checker reports it as `unkeyableBoundary` and puts it in `unchecked`, so nobody takes it as compared. A module-level function-call boundary is pending in the same way.

What does pair today is a store written as the target of an effect. Put `- writes: aws.dynamodb:Invoices` on an outcome of the boundary that touches the store, and the checker compares it against the storage accesses on that boundary's transitions.

Every boundary kind has its own label in `@suss/ir-core` (a store's is `storageLabel`), so an effect always takes a label and never a structured block. A binding with no name at all, such as a REST call whose method and path the code never settles, is left out of a draft. Writing it as a string would give something nobody would type back.

```ts
import { IntentDocSchema, intentDocToSummary } from "@suss/intent-ir";

const doc = IntentDocSchema.parse(/* parsed YAML / JSON */);
const summary = intentDocToSummary(doc); // normalised, checker-ready
```

`schema.ts` is the form an author writes, kept easy to write. `summary.ts` is the normalized form the checker consumes (boundaries as `ir-core` `BoundaryBinding`s, bodies as `TypeShape`s, one flat outcome list), plus the transform between the two. The `source` provenance (`author` / `inferred` / `inferred, curated`) comes along for the inference path.

The design is documented in [`design/proposals/intent-specs.md`](../../design/proposals/intent-specs.md).
