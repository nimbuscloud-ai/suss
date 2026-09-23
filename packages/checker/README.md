# @suss/checker

Part of [suss](https://github.com/nimbuscloud-ai/suss), which reads both sides of every call in a repository and says where the two disagree.

The checker compares two sides of a boundary. Given two `BehavioralSummary` objects, one provider and one consumer, it returns a list of `Finding`s that describe where they disagree.

## What this package is

`@suss/checker` implements the algorithm specified in [`docs/why/cross-boundary-checking.md`](../../docs/why/cross-boundary-checking.md). It has two entry points:

```ts
import { checkPair, checkAll } from "@suss/checker";

// Pairwise: compare one provider against one consumer
const findings = checkPair(provider, consumer);

// Automatic pairing: match all summaries by (method, path), check each pair
const result = checkAll(summaries);
// result.findings, result.pairs, result.unmatched
```

The checker does no I/O and writes nothing to disk. It does not care where the summaries came from: hand-authored JSON, extractor output and pinned baselines all have the same structure.

## Where it fits in suss

The checker depends only on `@suss/behavioral-ir`. The extractor, adapters and framework packs produce the summaries it consumes, but the checker has no runtime dependency on them. It works on the serialized IR and never sees the AST or compiler state. See [`docs/theory/architecture.md`](../../docs/theory/architecture.md).

## Flow reachability

Working out which unit a request reaches happens in two stages. The split between them follows from what a datalog engine can and cannot do.

The engine stores rows of data and joins two facts by lining them up on a column where the values are equal. That is the only way it combines facts. Choosing which of a router's rules takes a request needs something else. Each rule's condition has to run against the request, in whatever language that router writes its conditions in, and then one winner has to be picked from the rules that match. Neither step is an equality comparison, so neither can be written as a datalog rule. Both run in TypeScript first, once per router, using the selector for that router's condition language. By the time the engine sees anything, the choice is made and the engine is looking at a plain list of edges.

Walking those edges is a job the engine does well. You follow an edge to a node, then follow the edges out of that node, and keep going until nothing new shows up. That is ordinary recursion, so it is written as rules. It finishes even when the routing graph has a cycle. Each round can only produce pairs built from nodes already in the data, and a pair is never removed once it is derived. A set that only grows, drawn from a fixed pool, has to stop growing eventually. A load balancer that routes back to something upstream of it produces pairs that already exist, adds nothing new that round, and the evaluation stops.

## What each comparison assumes about the protocol

Comparing two sides of a boundary means assuming something about how the protocol behaves. Reporting an unhandled 404 assumes the status the handler wrote is the status the caller receives, and a middleware or a gateway can make that false. [`docs/theory/protocol-assumptions.md`](../../docs/theory/protocol-assumptions.md) lists every such assumption per protocol. It explains what a finding means once an assumption stops being true, and links the test that pins today's behaviour.

## Status

`checkPair` runs seven checks on each pair: provider coverage (with sub-case analysis), response misreads (a field read off a response whose body lacks it), consumer satisfaction, contract consistency (status and body shapes), the consumer against the declared contract, body compatibility (field presence), and semantic condition bridging (Level 5). It pairs boundaries automatically through `checkAll` / `pairSummaries`, and normalizes paths as it goes (`:id` ↔ `{id}`). See [`design/status.md`](../../design/status.md).

## More

- [Documentation](https://suss.sh/)
- [Every package and pack suss ships](https://suss.sh/packs/catalog)
- [Source and issues](https://github.com/nimbuscloud-ai/suss)

## Coverage

![coverage](../../.github/badges/coverage-checker.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../LICENSE).

---

For the checker's algorithm and finding semantics, see [`docs/why/cross-boundary-checking.md`](../../docs/why/cross-boundary-checking.md).
