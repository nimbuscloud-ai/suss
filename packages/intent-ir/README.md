# @suss/intent-ir

The team-authored side of the loop: what the code was *meant* to do, in a form that pairs against the derived `BehavioralSummary` of what it *does*.

## What this package is

Two citizens, discriminated by `kind`, both built on `@suss/ir-core` so intent and behaviour describe boundaries the same way:

- **System intent** (`kind: boundary`): what one boundary should do, as named outcomes. The boundary is REST, function-call, message-bus or storage, and every field of one comes off the `@suss/ir-core` schema for that protocol.
- **Outcome intent** (`kind: prd`): human `when` / `expect` scenarios, each with an optional `link` to a system-intent outcome (`<intent-name>.<outcome-id>`). A scenario with no `link` is a valid state to be in: it reads fully, and nothing has linked it to an outcome yet.

## What an outcome is

A transition says two things, and it needs at least one of them.

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
      - does: writes
        at:
          semantics: storage
          storageSystem: aws.dynamodb
          container: Invoices
```

`suss ask "what writes aws.dynamodb:Invoices"` is the question and "this outcome results in a write to aws.dynamodb:Invoices" is the assertion. `does` is `reads` or `writes`, the two verbs `relationsOf` in `@suss/behavioral-ir` gives an effect, and `at` is a boundary in the same vocabulary as the doc's own. Nothing here is per protocol, so a queue consumer and a table writer say what they do without a fourth outcome shape each.

The id and the `when` stay free-form on purpose. That is where a person writes what the outcome means, and it is what a PRD scenario links to: `invoice-intake.invoice-recorded`, read as "a duplicate delivery changes nothing", rather than a code word for the mechanism that carried it.

Adding `results` changes nothing about `response`, `returns` and `throws`. A doc that states only those parses and pairs the way it always did.

## Which boundaries pair, and which are pending

A boundary intent pairs when its boundary has a key. REST has one from its method and path, a function-call export has one from its package and export path, and a message-bus boundary has one from its channel.

A store has none. `storage.ts` in `@suss/ir-core` returns null for a storage identity key on purpose: a container name can be a pattern with holes that only a caller or the deployment settles, and the storage pass in `@suss/checker` grounds it before pairing. So a `kind: boundary` doc whose boundary is a store is authorable, and the checker reports it as `unkeyableBoundary` and puts it in `unchecked` rather than pretending to have compared it. That is the same pending state a module-level function-call boundary is in.

What does pair today is a store named as the target of an effect: put `does: writes` / `at: {semantics: storage, ...}` on an outcome of the boundary that touches the store, and the checker compares it against the storage accesses on that boundary's transitions.

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
