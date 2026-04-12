# @suss/adapter-typescript

TypeScript language adapter for suss — extracts behavioral structure from TypeScript source using ts-morph.

## What this package is

`@suss/adapter-typescript` is the Phase 2 language adapter. Its job is to walk TypeScript ASTs via ts-morph, identify code units (handlers, loaders, actions, etc.), and emit `RawCodeStructure` objects that the extractor can assemble into `BehavioralSummary` IR. It bridges the gap between raw TypeScript source and the framework-agnostic extraction pipeline.

## Where it sits in suss

Imports `@suss/behavioral-ir` for type references and `@suss/extractor` for the `RawCodeStructure` contract. Framework packs and the CLI consume it. It sits one level above the extractor in the pipeline, feeding it raw structures produced from TypeScript AST analysis.

## Status

Phase 2 in progress — the public API may still change. See [`docs/status.md`](../../docs/status.md).

See `docs/extraction-algorithm.md` for the design; public API will be documented once Phase 2 lands.

## Coverage

![coverage](../../../.github/badges/coverage-typescript.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For the canonical design, see [docs/architecture.md](../../../docs/architecture.md).
