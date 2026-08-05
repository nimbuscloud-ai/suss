# Proposal: one primitive, one implementation

Status: direction decided (2026-08-05). The list below is the scope;
each item lands as its own mostly-deletion change.

## Two incidents, one root

The week produced two bugs with the same anatomy. The message-bus
checker flagged every recorded-but-unnamed send as an orphan to a
queue named `""`, because it keeps its own channel index instead of
using the shared pairing. And the intent checker contradicts the
behavioral checker on the same run: a pages-api route serving `*`
pairs with GET clients in `suss check`, while `suss check --intent`
reports nobody serves GET, because the intent side does an
exact-string map lookup on `boundaryKey` while pairing moved to
bucket-then-agree.

Neither bug is in the shared primitive. Both are in a private copy of
it that did not learn what the original learned. Every second
implementation of an agreement rule is a reserved slot for the next
drift.

## The mechanism

Name the primitive, export it in a callable shape, delete the copies.
The intent checker's fix reads like this:

```ts
// before: its own index, exact strings
const byKey = new Map<string, BehavioralSummary[]>();
byKey.set(boundaryKey(binding), [summary]);
const impls = byKey.get(boundaryKey(intent.boundary)) ?? [];

// after: the same lookup pairing uses
const index = pairableIndex(summaries);
const impls = index.match(intent.boundary);
```

`pairableIndex` is a small ir-core export wrapping what
`pairSummaries` already does: bucket on `pairingKey`, settle with
`semanticsAgree`. The private map is deleted, and the contradiction
cannot recur because there is no second opinion left.

## The list, with the copy each item deletes

1. **Channel agreement.** The message-bus checker consumes the pairs
   and unmatched lists `pairSummaries` computes, and
   `channelPairing.ts` (`ChannelSet`, `addChannel`, `hasPair`) is
   deleted. This is the consolidation the code already promises
   (#174), now with two incidents pointing at it. First in line.
2. **Pairable lookup.** `pairableIndex` in ir-core; the intent
   checker's `indexCodeByBoundary` is deleted. Fixes the wildcard
   contradiction.
3. **Pairability in the fuzzer.** `everyBoundaryCanPair` re-lists per
   protocol which fields must be non-null and covers only two
   protocols. It calls `boundaryKey`/`pairingKey` instead, and gains
   the protocols it silently skipped.
4. **Boundary rendering.** `describeBinding` (checker),
   `formatRoute`/`formatSide` (check), `summaryLabel` (corroborate)
   are three fallback rules for one job. One `describeBoundary` in
   ir-core next to `boundaryKey`; three copies deleted.
5. **Descent rule.** Three implementations of "stop at a nested
   function": the shared barrier-aware `isDescentStop`, an inline
   copy in `extractDependencyCalls`, a third in the sub-unit context.
   One rule with the accessor/constructor variant folded in. This is
   also a precondition for the walk unification (#118), which needs
   one descent semantics before walks can merge.
6. **Pack helper kit.** Byte-identical or near copies across packs:
   `rootIdentifier` (x2), `unwrapJsonStringify` (x2),
   `process.env` matching (x3), string-literal reading (many),
   object-literal property reading (x6), `EffectArg` kind guards
   (x3). One exported kit in the extractor; the guide points at it.
7. **Cross-package reuse the imports already allow.** appsync
   reimplements `refTarget` (weaker, misses a shape manifest-aws
   handles) and GraphQL type decomposition (lower fidelity than
   contract/graphql's), while already importing from both packages
   for other reasons. Call the stronger versions; delete the local
   ones.

## Keeping copies from coming back

The deleted modules are the guard: reintroducing a copy means writing
a new file, which review sees, rather than extending an existing one,
which review misses. "Does it reuse what exists" stays on the review
checklist; no new gate is proposed until a copy actually recurs.
