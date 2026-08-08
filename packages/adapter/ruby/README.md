# @suss/adapter-ruby

Ruby language adapter for suss. It parses source with tree-sitter (WASM), resolves constant nesting with its own lexical binder, and emits behavioral structure through the same shared assembly layer the Python and TypeScript adapters use.

## What this package is

`@suss/adapter-ruby` is the Ruby language adapter, per [`docs/internal/facts-and-rules.md`](../../../docs/internal/facts-and-rules.md)'s Layer 1 contract: discover units, emit summaries in the shared IR, emit facts. It parses a file with `web-tree-sitter` and a vendored Ruby grammar (`grammar/tree-sitter-ruby.wasm`, no native build step), tracks class/module nesting to qualify a constant the way Ruby itself would resolve it lexically, and discovers graphql-ruby's class-based `field` DSL on a class extending a pack-configured base class. A `field :x, mutation: Mutations::Y` or `field :x, resolver: Queries::Z` reference is followed one hop: the referenced class's own file is located by Rails' constant-to-path convention and read for its declared return shape. Discovered units become `RawCodeStructure` objects handed to `@suss/extractor`'s `assembleSummary`, the same assembly code the other adapters use.

v0 (this slice) reads graphql-ruby only: `routes.rb` is a separate, much larger macro-expansion problem the [language-adapters proposal](../../../docs/internal/proposals/language-adapters.md) prices and defers. `require` is not resolved; class and module nesting is. A resolver's transitions are always empty (`branches: []`), since v0 does no path-engine work, and confidence is pinned low.

## The method behind a field

Most fields in a graphql-ruby schema have a method that answers them, and a summary that says nothing about what a field does should only say so when there is nothing to say. Two shapes cover almost all of them, and both sit in a parse tree the adapter already has:

- A method of the field's own name written in the same class. `field :display_name, String` next to `def display_name`.
- The `resolve` method on the class a `mutation:` or `resolver:` field points at. That class is already read for its declared shape, so its method costs nothing more to find. Which method name a wired class answers with is graphql-ruby's own, so the pack states it as `resolverMethodName` rather than the adapter naming it.

What the summary carries is what was found where the body should be:

- A method with work in it, or one with nothing in it, sets `bodyContent` accordingly. The summary no longer says the field is a declaration with no body behind it. Since nothing in the body matched a shape this pack looks for, the extractor's own sentence takes over: what the field does is not described here.
- A field with no method at all keeps `bodyContent: "absent"` and the no-body sentence, which is correct for it: graphql-ruby answers such a field by reading the attribute off the object it was resolved against.
- A wired class the reader could not reach names what stopped it (no file where the constant-to-path convention says to look, no class by that name in it, no `resolve` method of its own, a wiring value that is not a constant path) as a reading, which lands as a gap on the summary.

What a body *does* still goes unread. Reading it takes the path engine: statements to enumerate, a return value to shape, calls to resolve against something that knows what they return. `RawCodeStructure.dependencyCalls` is not a shortcut around that, since nothing in the summary assembly reads it. A field's location also stays where the field is declared rather than moving to a resolver method in another file, so the path and the line numbers on a summary keep naming the same place.

## Where it sits in suss

Depends on `@suss/extractor` (for `RawCodeStructure` / `assembleSummary`), `@suss/behavioral-ir`, `@suss/datalog` (for the fact database), and `web-tree-sitter`. Framework packs under `packages/framework/*` (starting with `@suss/framework-graphql-ruby`) consume its `RubyPack` contract; nothing in this package knows what any particular library's classes or DSL calls are named beyond graphql-ruby's own `field` / `argument` / `type` verbs, which the discovery logic reads structurally rather than through pack configuration.

## Grammar asset

`grammar/tree-sitter-ruby.wasm` is a checked-in binary asset, not a build output. See [`grammar/README.md`](./grammar/README.md) for its provenance and how to bump it.

## Coverage

![coverage](../../../.github/badges/coverage-ruby.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).
