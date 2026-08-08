# @suss/adapter-ruby

Ruby language adapter for suss. It parses source with tree-sitter (WASM), resolves constant nesting with its own lexical binder, and emits behavioral structure through the same shared assembly layer the Python and TypeScript adapters use.

## What this package is

`@suss/adapter-ruby` is the Ruby language adapter, per [`docs/internal/facts-and-rules.md`](../../../docs/internal/facts-and-rules.md)'s Layer 1 contract: discover units, emit summaries in the shared IR, emit facts. It parses a file with `web-tree-sitter` and a vendored Ruby grammar (`grammar/tree-sitter-ruby.wasm`, no native build step), tracks class/module nesting to qualify a constant the way Ruby itself would resolve it lexically, and discovers graphql-ruby's class-based `field` DSL on a class extending a pack-configured base class. A `field :x, mutation: Mutations::Y` or `field :x, resolver: Queries::Z` reference is followed one hop: the referenced class's own file is located by Rails' constant-to-path convention and read for its declared return shape. Discovered units become `RawCodeStructure` objects handed to `@suss/extractor`'s `assembleSummary`, the same assembly code the other adapters use.

v0 (this slice) reads graphql-ruby only: `routes.rb` is a separate, much larger macro-expansion problem the [language-adapters proposal](../../../docs/internal/proposals/language-adapters.md) prices and defers. `require` is not resolved; class and module nesting is. A resolver's transitions are always empty (`branches: []`), since v0 does no path-engine work, and confidence is pinned low.

## The method behind a field

Most fields in a graphql-ruby schema have a method that answers them, and a summary should only say a field has nothing behind it when nothing is.

The library calls a field's method with `public_send`, so the method that answers it can be written anywhere in the class's ancestry. `ancestry.ts` walks that chain in Ruby's own lookup order: what a class prepends, the class itself, what it includes, then its superclass and that superclass's chain, each ancestor located by the same constant-to-path convention a `mutation:` or `resolver:` reference already uses. A field is answered by a method of its own name found along that chain; a wired field is answered by the `resolve` method found along the wired class's chain. Which method name a wired class answers with is graphql-ruby's own, so the pack states it as `resolverMethodName`. So is where a project's chain ends: `ancestryRootClassNames` names the library's own root classes, and reaching one means the walk followed everything a project defined.

The same walk feeds the declared contract, read most distant ancestor first, so a mutation inheriting `argument` declarations from a base mutation carries them.

What the summary then says:

- A method that was found sets `bodyContent` from what is in it. Nothing in that body matches a shape this pack looks for, so the extractor's own sentence takes over: what the field does is not described here.
- A field whose whole ancestry was read and holds no such method keeps `bodyContent: "absent"` and the no-body sentence. That is correct for it: the library answers such a field by reading the attribute off the object it was resolved against.
- A walk that stopped early leaves `bodyContent` unset and carries one sentence naming what stopped it: an ancestor whose file the convention names nothing for, a `define_method` call whose names a reader of `def` nodes cannot see, a wiring value that is not a constant path. `bodyContent` stays unset there because the extractor writes its own sentence from that field, and every value of it would be a claim this reader cannot make. `method_missing` is not read and is one more thing the walk cannot see.

What a body *does* still goes unread. Reading it takes the path engine: statements to enumerate, a return value to shape, calls to resolve against something that knows what they return. `RawCodeStructure.dependencyCalls` is not a shortcut around that, since nothing in the summary assembly reads it. A field's location also stays where the field is declared rather than moving to a resolver method in another file, so the path and the line numbers on a summary keep naming the same place.

One thing the walk deliberately does not do: a `field` declared on a base object type is not discovered on its subclasses. That would change which units exist rather than what they say about themselves, and it is a separate slice.

## Where it sits in suss

Depends on `@suss/extractor` (for `RawCodeStructure` / `assembleSummary`), `@suss/behavioral-ir`, `@suss/datalog` (for the fact database), and `web-tree-sitter`. Framework packs under `packages/framework/*` (starting with `@suss/framework-graphql-ruby`) consume its `RubyPack` contract; nothing in this package knows what any particular library's classes or DSL calls are named beyond graphql-ruby's own `field` / `argument` / `type` verbs, which the discovery logic reads structurally rather than through pack configuration.

## Grammar asset

`grammar/tree-sitter-ruby.wasm` is a checked-in binary asset, not a build output. See [`grammar/README.md`](./grammar/README.md) for its provenance and how to bump it.

## Coverage

![coverage](../../../.github/badges/coverage-ruby.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).
