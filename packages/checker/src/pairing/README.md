# pairing/

The base pairing primitives every per-domain checker builds on: REST path normalization, the `boundaryKey` function that maps any `BoundaryBinding` to a stable string, GraphQL operation→resolver pairing with SDL-driven nested-field validation, and semantic bridging (provider literals the consumer fails to discriminate).

## Place in the pipeline

Runs early in `checkAll()`. `pairSummaries` is the entry point most other checkers consume — it returns `SummaryPair[]` plus unmatched buckets for diagnostics. GraphQL pairing is its own pass because operation→resolver matching needs SDL parsing. Semantic bridging runs after `coverage/` to flag distinguishing literals consumers miss.

## Key files

- `pairing.ts:normalizePath` — Express-style `:param` → brace-style `{param}`, lowercase static segments, strip trailing slashes (except bare `/`).
- `pairing.ts:boundaryKey` — single function that maps every supported `BoundaryBinding` to a stable string. Returns `null` for bindings that can't be paired (REST without method/path, function-call without exportPath, etc.).
- `pairing.ts:pairSummaries` — the public pairing pass. Returns `SummaryPair[]` and `unmatched.{providers, consumers, noBinding}`.
- `graphqlPairing.ts:pairGraphqlOperations` — operation-level pairing. Lazy-parses the SDL once per schema and caches; nested-selection validation walks the AST.
- `semanticBridging.ts:checkSemanticBridging` — flags provider-side literal values and field-presence discriminators that the consumer doesn't test on.

## Non-obvious things

- **Null keys land in `unmatched.noBinding`.** A summary with a binding but no usable key (e.g. REST with empty path) is intentionally not paired; it's recorded so reports can show what was skipped and why.
- **GraphQL schema parsing is lazy + cached.** First operation referencing a schema text triggers a parse; subsequent operations on the same schema text hit the cache. Schemas are compared by string equality of the `graphqlSchemaSdl` field, so identical schemas inlined in different summaries share the parsed result.
- **Nested-selection validation stops at scalars.** Walking GraphQL selections terminates when the type resolves to `Int`, `String`, `Boolean`, or any custom scalar — you can't select fields on a scalar.
- **Semantic bridging looks for "distinguishing" fields.** A provider field is distinguishing when (a) at least one sibling transition has a different literal value at the same path, or (b) at least one sibling transition lacks the field entirely. Consumer code that never tests for either is flagged — they'll treat the branches as identical.
- **Consumer field tests are predicate-walked.** Equality, negated equality, and truthiness tests on body paths count. A consumer with zero such tests for a status is a catch-all and emits no findings (they explicitly opted into the union).

## Sibling modules

- `coverage/responseMatch.ts` — uses `extractResponseStatus` for status grouping; pairing supplies the (provider, consumer) tuples that coverage walks.
- `contract/declaredContract.ts` — provides status- and body-accessor lookups for semantic bridging.
- `interactions/dispatcher.ts` — interaction-class checkers do their own pairing keyed by semantics; the base pairing here handles everything that maps to `boundaryKey`.
