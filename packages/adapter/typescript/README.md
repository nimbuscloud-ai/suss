# @suss/adapter-typescript

TypeScript language adapter for suss — extracts behavioral structure from TypeScript source using ts-morph.

## What this package is

`@suss/adapter-typescript` is the TypeScript language adapter. It walks ASTs via ts-morph, identifies code units (handlers, loaders, actions, client call sites), and emits `RawCodeStructure` objects that the extractor assembles into `BehavioralSummary` IR.

Supports both provider-side extraction (handler registration, terminal discovery, contract reading, body-shape extraction) and client-side extraction (call-site discovery, enclosing-function lifting, response field tracking via `expectedInput`).

## Where it sits in suss

Imports `@suss/behavioral-ir` for type references and `@suss/extractor` for the `RawCodeStructure` contract. Framework packs and the CLI consume it. It sits one level above the extractor in the pipeline, feeding it raw structures produced from TypeScript AST analysis.

## Status

Stable. Public API: `createTypeScriptAdapter` returns an adapter with `extractFromFiles` and `extractAll` methods. Provider-side extraction (handlers, terminals, contracts, body shapes) and client-side extraction (call sites, response field tracking) are both supported. See [`docs/extraction-algorithm.md`](../../../docs/extraction-algorithm.md) for the algorithm and [`docs/status.md`](../../../docs/status.md) for the capability matrix.

## Coverage

![coverage](../../../.github/badges/coverage-typescript.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For the canonical design, see [docs/architecture.md](../../../docs/architecture.md).
