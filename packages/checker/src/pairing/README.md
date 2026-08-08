# pairing/

These are the base pairing primitives every per-domain checker builds on: REST path normalization, the `boundaryKey` function that maps any `BoundaryBinding` to a stable string, pairing a GraphQL operation with its resolver (with nested fields validated against the SDL), and semantic bridging (provider literals the consumer fails to discriminate).

## Place in the pipeline

`checkAll()` runs this early. `pairSummaries` is the entry point most other checkers use, and it returns `SummaryPair[]` plus unmatched buckets for diagnostics. GraphQL pairing is its own pass, because matching an operation to its resolver needs the SDL parsed. Semantic bridging runs after `coverage/`, to flag distinguishing literals that consumers miss.

## Key files

- `pairing.ts:normalizePath` turns Express-style `:param` into brace-style `{param}`, lowercases static segments, and strips trailing slashes (except on a bare `/`).
- `pairing.ts:boundaryKey` is the single function that maps every supported `BoundaryBinding` to a stable string. It returns `null` for bindings that can't be paired (REST without a method or path, function-call without an exportPath, and so on).
- `pairing.ts:pairSummaries` is the public pairing pass. It returns `SummaryPair[]` and `unmatched.{providers, consumers, noBinding}`.
- `graphqlPairing.ts:pairGraphqlOperations` pairs at the operation level. It parses the SDL lazily, once per schema, and caches the result; validating nested selections walks the AST.
- `semanticBridging.ts:checkSemanticBridging` flags provider-side literal values, and fields whose presence tells one branch from another, that the consumer never tests on.

## Non-obvious things

- **Null keys land in `unmatched.noBinding`.** A summary with a binding but no usable key (e.g. REST with an empty path) is deliberately left unpaired, and it is recorded so that reports can show what was skipped and why.
- **A key bucket can contain summaries that pair with nothing in it.** A message-bus key has only the subject in it, so `default#order.placed` and `order.placed` land together, and a handler that cannot know its bus still meets the template that gives one. `bindingsPair` then compares the buses inside the bucket, and two buses with different names stay apart. That is why matching is tracked per summary rather than per key.
- **`checkAll` does not put message-bus summaries in the unmatched lists.** `checkMessageBus` already reports a channel that paired with nothing, with a severity and with knowledge of who sends to it. Pairing owns the pair list, and that pass owns every judgement about a channel.
- **GraphQL schema parsing is lazy + cached.** The first operation that refers to a schema text triggers a parse, and later operations on the same schema text hit the cache. Schemas are compared by string equality on the `graphqlSchemaSdl` field, so identical schemas inlined in different summaries share one parsed result.
- **Nested-selection validation stops at scalars.** The walk over GraphQL selections stops when the type resolves to `Int`, `String`, `Boolean`, or any custom scalar, because you can't select fields on a scalar.
- **Semantic bridging looks for "distinguishing" fields.** A provider field is distinguishing when (a) at least one sibling transition has a different literal value at the same path, or (b) at least one sibling transition lacks the field entirely. Consumer code that tests for neither gets flagged, because it will treat the branches as identical.
- **Consumer field tests are predicate-walked.** Equality tests, negated equality tests, and truthiness tests on body paths all count. A consumer with none of those for a status is a catch-all and produces no findings, since it opted into the union on purpose.

## Sibling modules

- `coverage/responseMatch.ts` uses `extractResponseStatus` to group by status, and pairing supplies the (provider, consumer) tuples that coverage walks.
- `contract/declaredContract.ts` provides the status- and body-accessor lookups that semantic bridging needs.
- `interactions/dispatcher.ts` covers the interaction-class checkers, which do their own pairing keyed by semantics. The base pairing here handles everything that maps to `boundaryKey`.
