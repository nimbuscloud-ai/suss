# @suss/checker

Pairwise cross-boundary checker. Given two `BehavioralSummary` objects (one provider, one consumer), it produces a list of `Finding`s describing mismatches.

## What this package is

`@suss/checker` implements the algorithm specified in [`docs/cross-boundary-checking.md`](../../docs/cross-boundary-checking.md). Two entry points:

```ts
import { checkPair, checkAll } from "@suss/checker";

// Pairwise: compare one provider against one consumer
const findings = checkPair(provider, consumer);

// Automatic pairing: match all summaries by (method, path), check each pair
const result = checkAll(summaries);
// result.findings, result.pairs, result.unmatched
```

The checker does no I/O, keeps nothing on disk, and takes no view on where the summaries came from. Hand-authored JSON, extractor output, and pinned baselines all have the same structure.

## Where it fits in suss

The checker depends only on `@suss/behavioral-ir`. The extractor, adapters, and framework packs produce the summaries it consumes, but the checker has no runtime dependency on them. It works on the serialized IR rather than on the AST or compiler state. See [`docs/architecture.md`](../../docs/architecture.md).

## Flow reachability

Working out who a request reaches happens in two stages, and where we split them comes down to what a datalog engine can and cannot do.

The engine stores rows of data and matches them up by comparing values for equality. That is all it can do with two facts: line them up on a column where the values are identical. Choosing which of a router's rules should take a request is a different kind of work. You have to run each rule's condition against the request, in whatever language that particular router writes its conditions in, and then pick a single winner from the ones that match. Running a condition is not an equality comparison, and neither is picking a winner, so we cannot express either as a datalog rule. We do both in TypeScript first, once per router, using the selector that understands that router's condition language. By the time the engine sees anything, the choice is already made and it is looking at a plain list of edges.

Walking those edges is the opposite situation. You follow an edge to a node, then follow the edges leading out of that node, and keep going until nothing new shows up. That is ordinary recursion, which is exactly what the engine is good at, so we write it as rules. It finishes even when the routing graph has a cycle in it, for the usual reason: each round can only produce pairs built from nodes that are already in the data, and we never remove a pair once we have it. A set that only ever grows, drawn from a fixed pool, has to stop growing eventually. So a load balancer that routes back to something upstream of it produces pairs we already have, contributes nothing new that round, and the evaluation stops.

## Status

The checker runs six checks: provider coverage (with sub-case analysis), consumer satisfaction, contract consistency (status and body shapes), body compatibility (field presence), and semantic condition bridging (Level 5). It pairs boundaries automatically through `checkAll` / `pairSummaries`, normalizing paths as it goes (`:id` ↔ `{id}`). See [`docs/status.md`](../../docs/status.md).

## Coverage

![coverage](../../.github/badges/coverage-checker.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../LICENSE).

---

For the checker's algorithm and finding semantics, see [`docs/cross-boundary-checking.md`](../../docs/cross-boundary-checking.md).
