# @suss/adapter-ruby

Ruby language adapter for suss. It parses source with tree-sitter (WASM), resolves constant nesting with its own lexical binder, and emits behavioral structure through the same shared assembly layer the Python and TypeScript adapters use.

## What this package is

`@suss/adapter-ruby` is the Ruby language adapter, per [`docs/internal/facts-and-rules.md`](../../../docs/internal/facts-and-rules.md)'s Layer 1 contract: discover units, emit summaries in the shared IR, emit facts. It parses a file with `web-tree-sitter` and a vendored Ruby grammar (`grammar/tree-sitter-ruby.wasm`, no native build step), tracks class/module nesting to qualify a constant the way Ruby itself would resolve it lexically, and discovers graphql-ruby's class-based `field` DSL on a class extending a pack-configured base class. A `field :x, mutation: Mutations::Y` or `field :x, resolver: Queries::Z` reference is followed one hop: the referenced class's own file is located by Rails' constant-to-path convention and read for its declared return shape. Discovered units become `RawCodeStructure` objects handed to `@suss/extractor`'s `assembleSummary`, the same assembly code the other adapters use.

v0 (this slice) reads graphql-ruby only: `routes.rb` is a separate, much larger macro-expansion problem the [language-adapters proposal](../../../docs/internal/proposals/language-adapters.md) prices and defers. `require` is not resolved; class and module nesting is. A resolver's transitions are always empty (`branches: []`), since v0 does no path-engine work, and confidence is pinned low.

## Where it sits in suss

Depends on `@suss/extractor` (for `RawCodeStructure` / `assembleSummary`), `@suss/behavioral-ir`, `@suss/datalog` (for the fact database), and `web-tree-sitter`. Framework packs under `packages/framework/*` (starting with `@suss/framework-graphql-ruby`) consume its `RubyPack` contract; nothing in this package knows what any particular library's classes or DSL calls are named beyond graphql-ruby's own `field` / `argument` / `type` verbs, which the discovery logic reads structurally rather than through pack configuration.

## Grammar asset

`grammar/tree-sitter-ruby.wasm` is a checked-in binary asset, not a build output. See [`grammar/README.md`](./grammar/README.md) for its provenance and how to bump it.

## Coverage

![coverage](../../../.github/badges/coverage-ruby.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).
