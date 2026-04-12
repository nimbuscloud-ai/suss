# @suss/checker

Pairwise cross-boundary checker. Given two `BehavioralSummary` objects — one provider, one consumer — produces a list of `Finding`s describing mismatches.

## What this package is

`@suss/checker` implements the algorithm specified in [`docs/cross-boundary-checking.md`](../../docs/cross-boundary-checking.md). Its public entry point is a pure function:

```ts
import { checkPair } from "@suss/checker";
import type { BehavioralSummary, Finding } from "@suss/behavioral-ir";

const findings: Finding[] = checkPair(provider, consumer);
```

No I/O, no persistence, no opinions about where the summaries came from. Hand-authored JSON, extractor output, or pinned baselines — they're all the same shape.

## Where it sits in suss

Depends only on `@suss/behavioral-ir`. The extractor, adapters, and framework packs produce the summaries it consumes, but the checker has no runtime dependency on them — it operates on the serialized IR, not on AST or compiler state. See [`docs/architecture.md`](../../docs/architecture.md).

## Status

Pairwise checker is in progress. All three checks (provider coverage, consumer satisfaction, contract consistency) are wired up against status codes and exposed via `suss check`. Body-shape matching is the next layer — structured body shapes now flow through the IR from the adapter, but the checker does not yet compare them across a boundary. See [`docs/status.md`](../../docs/status.md).

## Coverage

![coverage](../../.github/badges/coverage-checker.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../LICENSE).

---

For the checker's algorithm and finding semantics, see [`docs/cross-boundary-checking.md`](../../docs/cross-boundary-checking.md).
