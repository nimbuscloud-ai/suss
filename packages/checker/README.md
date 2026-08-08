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

## Status

The checker runs six checks: provider coverage (with sub-case analysis), consumer satisfaction, contract consistency (status and body shapes), body compatibility (field presence), and semantic condition bridging (Level 5). It pairs boundaries automatically through `checkAll` / `pairSummaries`, normalizing paths as it goes (`:id` ↔ `{id}`). See [`docs/status.md`](../../docs/status.md).

## Coverage

![coverage](../../.github/badges/coverage-checker.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../LICENSE).

---

For the checker's algorithm and finding semantics, see [`docs/cross-boundary-checking.md`](../../docs/cross-boundary-checking.md).
