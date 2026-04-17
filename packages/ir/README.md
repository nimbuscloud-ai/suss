# @suss/behavioral-ir

Core type definitions and utilities for the suss behavioral intermediate representation.

## What this package is

`@suss/behavioral-ir` defines the shared type vocabulary that the rest of suss speaks. It contains the `BehavioralSummary` interface — the canonical output of the extraction pipeline — along with all the supporting types: `Transition`, `Predicate`, `Input`, `Output`, `Effect`, `TypeShape`, and more. It also provides `diffSummaries`, the only runtime utility in this package.

Every other suss package either consumes these types or produces values that conform to them. Nothing in this package depends on any other suss package.

## Where it sits in suss

Zero dependencies — `@suss/behavioral-ir` is the foundation everyone else imports. `@suss/extractor`, `@suss/adapter-typescript`, all framework packs, and the CLI all depend on it. It never imports from suss siblings.

## Status

Stable. The IR types and `diffSummaries` are the public API. The format is also published as a [JSON Schema](schema/behavioral-summary.schema.json) and a [spec document](../../docs/behavioral-summary-format.md) so consumers in any language can validate and interpret summaries without taking a runtime dependency on this package.

## Minimal usage

```ts
import type { BehavioralSummary, Transition } from "@suss/behavioral-ir";

function firstTransition(summary: BehavioralSummary): Transition | undefined {
  return summary.transitions[0];
}
```

## Coverage

![coverage](../../.github/badges/coverage-ir.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../LICENSE).

---

For the canonical design, see [docs/architecture.md](../../docs/architecture.md).
