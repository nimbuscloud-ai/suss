# pairing/

This directory has the base pairing code that every per-domain checker builds on. It covers REST path normalization, the `boundaryKey` function that maps any `BoundaryBinding` to a stable string, and pairing a GraphQL operation with its resolver, with nested fields validated against the SDL. It also has semantic bridging, which finds provider literals the consumer fails to tell apart.

## Place in the pipeline

`checkAll()` runs this early. `pairSummaries` is the entry point most other checkers use. It returns `SummaryPair[]` plus unmatched buckets for diagnostics. GraphQL pairing runs as a separate pass, because matching an operation to its resolver needs the SDL parsed. Semantic bridging runs after `coverage/` and flags distinguishing literals that consumers miss.

## Key files

- `normalizePath` (in `@suss/ir-core`) turns Express-style `:param` into brace-style `{param}` and keeps a range modifier on the hole: `{tenant?}` for zero or one segment, `{rest+}` for one or more, `{rest*}` for zero or more. It lowercases static segments and strips trailing slashes, except on a bare `/`. A bare `*` segment means zero or more segments, the way Express 4 reads it.
- `boundaryKey` (in `@suss/ir-core`) is the single function that maps every supported `BoundaryBinding` to a stable string. It returns `null` for bindings that can't be paired, such as REST without a method or path, or function-call without an exportPath. `spansBuckets`, `bucketsMeet` and `bucketRank` are defined next to it. A binding whose path has a ranged hole or a set piece `(v1|v2)` spans more than one bucket, and the protocol decides which other buckets it meets and how specific it is.
- `groundedPath.ts:groundedKeys` returns the bucket a summary lands in: the key together with the binding it was made from. The pass uses that binding to ask the protocol whether two buckets meet.
- `pairing.ts:pairSummaries` is the public pairing pass. It returns `SummaryPair[]` and `unmatched.{providers, consumers, noBinding}`. A consumer is matched against its own bucket and against every spanning bucket that meets it. The highest-ranked bucket with an agreeing provider wins. When two buckets have the same rank, the pass reports them as ambiguous and does not pair.
- `graphqlPairing.ts:pairGraphqlOperations` pairs at the operation level. It parses the SDL lazily, once per schema, and caches the result. Validating nested selections walks the AST.
- `semanticBridging.ts:checkSemanticBridging` flags provider-side literal values the consumer never tests on, and fields whose presence tells one branch from another that the consumer never tests on either.
- `mostSpecificName.ts:mostSpecificName` picks between storage providers whose declared names all cover what one consumer reached. Deploy-time names have holes in them, so more than one can cover a single name. The one that states more fixed text wins. When providers state the same amount, none of them wins, and the caller reports the tie instead of pairing with all of them. Route paths do not use this. A path with an optional segment states more text than the same path without it, yet it admits a superset of requests. Routes are ranked by what the protocol counts instead (`pathSpecificity` in `@suss/ir-core`).

## Gotchas

- **Null keys land in `unmatched.noBinding`.** A summary with a binding but no usable key (e.g. REST with an empty path) is left unpaired on purpose. It is recorded so reports can show what was skipped and why.
- **A key bucket can contain summaries that pair with nothing in it.** A message-bus key contains only the subject, so `default#order.placed` and `order.placed` land together. That lets a handler that cannot know its bus still meet the template that declares one. `bindingsPair` then compares the buses inside the bucket, and two buses with different names stay apart. For this reason matching is tracked per summary and not per key.
- **`checkAll` does not put message-bus summaries in the unmatched lists.** `checkMessageBus` already reports a channel that paired with nothing, with a severity and with what it knows about who sends to it. Pairing produces the pair list, and `checkMessageBus` makes every judgement about a channel.
- **The schema belongs to the document, and resolvers point at it.** A GraphQL schema is one document that defines many boundaries. The reader emits one summary for that document, with the SDL at `metadata.graphql.schemaSdl`, and gives every resolver it read from that document the same `metadata.sourceDocument.label`. `pairGraphqlOperations` builds the label-to-SDL map once per pass and looks a resolver's label up in it. A schema of 240KB across 222 root fields costs 240KB in the artifact instead of 51MB. When two document summaries claim one label with different text, both drop out of the map, since keeping either one would check the other's fields against the wrong text. Their resolvers then go unchecked, the same as a resolver with no schema.
- **A reader with no document summary can still write the SDL beside the resolver.** The pass reads that copy when the label lookup finds nothing, so artifacts written before the document summary existed keep working.
- **GraphQL schema parsing is lazy and cached.** The first operation that refers to a schema text triggers a parse, and later operations on the same text hit the cache. Schemas are compared by string equality, so two documents with identical text share one parsed result.
- **Nested-selection validation stops at scalars.** The walk over GraphQL selections stops when the type resolves to `Int`, `String`, `Boolean`, or any custom scalar, because you can't select fields on a scalar.
- **Semantic bridging looks for "distinguishing" fields.** A provider field is distinguishing when (a) at least one sibling transition has a different literal value at the same path, or (b) at least one sibling transition lacks the field entirely. Consumer code that tests for neither gets flagged, because it will treat the branches as identical.
- **Consumer field tests come from walking predicates.** Equality tests, negated equality tests, and truthiness tests on body paths all count. A consumer with none of those for a status is a catch-all. It doesn't produce findings, since it accepted the whole union on purpose.

## Sibling modules

- `coverage/responseMatch.ts` uses `extractResponseStatus` to group by status. Pairing supplies the (provider, consumer) tuples that coverage walks.
- `contract/declaredContract.ts` provides the status- and body-accessor lookups that semantic bridging needs.
- `interactions/dispatcher.ts` serves the interaction-class checkers, which do their own pairing keyed by semantics. The base pairing here handles everything that maps to `boundaryKey`.
