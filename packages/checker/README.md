# @suss/checker

Pairwise cross-boundary checker. Given two `BehavioralSummary` objects — one provider, one consumer — produces a list of `Finding`s describing mismatches.

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

No I/O, no persistence, no opinions about where the summaries came from. Hand-authored JSON, extractor output, or pinned baselines — they're all the same shape.

## Where it sits in suss

Depends only on `@suss/behavioral-ir`. The extractor, adapters, and framework packs produce the summaries it consumes, but the checker has no runtime dependency on them — it operates on the serialized IR, not on AST or compiler state. See [`docs/architecture.md`](../../docs/architecture.md).

## Status

Six checks: provider coverage (with sub-case analysis), consumer satisfaction, contract consistency (status + body shapes), body compatibility (field presence), semantic condition bridging (Level 5). Automatic boundary pairing via `checkAll` / `pairSummaries` with path normalization (`:id` ↔ `{id}`). See [`docs/status.md`](../../docs/status.md).

## Coverage

![coverage](../../.github/badges/coverage-checker.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../LICENSE).

---

For the checker's algorithm and finding semantics, see [`docs/cross-boundary-checking.md`](../../docs/cross-boundary-checking.md).
