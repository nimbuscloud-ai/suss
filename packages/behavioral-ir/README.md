# @suss/behavioral-ir

Part of [suss](https://github.com/nimbuscloud-ai/suss), which reads both sides of every call in a repository and says where the two disagree.

Core type definitions and utilities for the suss behavioral intermediate representation.

## What this package is

`@suss/behavioral-ir` defines the types the rest of suss shares. It contains the `BehavioralSummary` interface, which is the canonical output of the extraction pipeline, along with the supporting types such as `Transition`, `Predicate`, `Input`, `Output`, `Effect` and `TypeShape`. It also provides `diffSummaries`, the only runtime utility in this package.

Every other suss package either consumes these types or produces values that conform to them. This package does not depend on any other suss package.

## Where it fits in suss

`@suss/behavioral-ir` has zero dependencies, and every other package builds on it. `@suss/extractor`, `@suss/adapter-typescript`, all framework packs, and the CLI depend on it. It never imports from its suss siblings.

## Status

Stable. The IR types and `diffSummaries` are the public API. The format is also published as a [JSON Schema](schema/behavioral-summary.schema.json) and a [spec document](../../docs/reference/summary-format.md), so consumers in any language can validate and interpret summaries without a runtime dependency on this package.

## Minimal usage

```ts
import type { BehavioralSummary, Transition } from "@suss/behavioral-ir";

function firstTransition(summary: BehavioralSummary): Transition | undefined {
  return summary.transitions[0];
}
```

## More

- [Documentation](https://suss.sh/)
- [Every package and pack suss ships](https://suss.sh/packs/catalog)
- [Source and issues](https://github.com/nimbuscloud-ai/suss)

## Coverage

![coverage](../../.github/badges/coverage-ir.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../LICENSE).

---

For the canonical design, see [docs/theory/architecture.md](../../docs/theory/architecture.md).
