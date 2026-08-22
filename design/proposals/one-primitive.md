# Proposal: one primitive, one implementation

Status: direction decided (2026-08-05). The list below is the scope;
each item lands as its own mostly-deletion change.

## Two incidents, one root

We hit two bugs this week with the same anatomy. The message-bus
checker flagged every recorded-but-unnamed send as an orphan to a
queue named `""`, because it keeps its own channel index instead of
using the shared pairing. And the intent checker contradicts the
behavioral checker on the same run. A pages-api route serving `*`
pairs with GET clients in `suss check`, while `suss check --intent`
reports that nobody serves GET. That happens because the intent side
does an exact-string map lookup on `boundaryKey`, and pairing has since
moved to bucketing first and agreeing second.

Neither bug is in the shared primitive. Both are in a private copy of
it that did not learn what the original learned. Every second
implementation of an agreement rule leaves a place for the next drift
to happen.

## The mechanism

Name the primitive, export it as something callers can call, and delete
the copies. The fix in the intent checker looks like this:

```ts
// before: its own index, exact strings
const byKey = new Map<string, BehavioralSummary[]>();
byKey.set(boundaryKey(binding), [summary]);
const impls = byKey.get(boundaryKey(intent.boundary)) ?? [];

// after: the same lookup pairing uses
const index = pairableIndex(summaries);
const impls = index.match(intent.boundary);
```

`pairableIndex` is a small ir-core export that wraps what
`pairSummaries` already does: it buckets on `pairingKey` and settles
with `semanticsAgree`. The private map is deleted, and the contradiction
cannot recur because there is no second opinion left.

## The list, with the copy each item deletes

1. **Channel agreement.** The message-bus checker consumes the pairs
   and unmatched lists `pairSummaries` computes, and
   `channelPairing.ts` (`ChannelSet`, `addChannel`, `hasPair`) is
   deleted. This is the consolidation the code already promises
   (#174), now with two incidents pointing at it. It goes first.
2. **Pairable lookup.** Add `pairableIndex` to ir-core and delete the
   intent checker's `indexCodeByBoundary`. That fixes the wildcard
   contradiction.
3. **Pairability in the fuzzer.** `everyBoundaryCanPair` lists again,
   protocol by protocol, which fields must be non-null, and it covers
   only two protocols. It calls `boundaryKey`/`pairingKey` instead, and
   gains the protocols it silently skipped.
4. **Boundary rendering.** `describeBinding` (checker),
   `formatRoute`/`formatSide` (check), and `summaryLabel` (corroborate)
   are three fallback rules for one job. Put one `describeBoundary` in
   ir-core next to `boundaryKey`, and delete the three copies.
5. **Descent rule.** Three pieces of code implement "stop at a nested
   function": the shared barrier-aware `isDescentStop`, an inline
   copy in `extractDependencyCalls`, a third in the sub-unit context.
   Make it one rule, with the accessor and constructor variant folded
   in. It is also a precondition for the walk unification (#118), which
   needs one meaning of descent before the walks can merge.
6. **Pack helper kit.** Packs contain copies of each other's helpers
   that are byte-identical or close to it: `rootIdentifier` (x2),
   `unwrapJsonStringify` (x2), `process.env` matching (x3),
   string-literal reading (many), object-literal property reading (x6),
   `EffectArg` kind guards (x3). Export one kit from the extractor, and
   have the guide point at it.
7. **Cross-package reuse the imports already allow.** appsync
   reimplements `refTarget` (a weaker version that misses a case
   manifest-aws handles), and it takes GraphQL types apart at lower
   fidelity than contract/graphql does, while it already imports from
   both packages for other reasons. Call the stronger versions and
   delete the local ones.

## Keeping copies from coming back

Deleting the modules is what guards this. To bring a copy back you have
to write a new file, which review sees, rather than extend an existing
one, which review misses. "Does it reuse what exists" stays on the
review checklist, and we are not proposing a new gate until a copy
actually comes back.
