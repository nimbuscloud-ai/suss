# @suss/adapter-ruby

Ruby language adapter for suss. It parses source with tree-sitter (WASM), resolves constant nesting with its own lexical binder, and emits behavioral structure through the same shared assembly layer the Python and TypeScript adapters use.

## What this package is

`@suss/adapter-ruby` is the Ruby language adapter, per [`docs/internal/facts-and-rules.md`](../../../docs/internal/facts-and-rules.md)'s Layer 1 contract: discover units, emit summaries in the shared IR, emit facts. It parses a file with `web-tree-sitter` and a vendored Ruby grammar (`grammar/tree-sitter-ruby.wasm`, no native build step), tracks class/module nesting to qualify a constant the way Ruby itself would resolve it lexically, and discovers graphql-ruby's class-based `field` DSL on a class extending a pack-configured base class. A `field :x, mutation: Mutations::Y` or `field :x, resolver: Queries::Z` reference is followed one hop: the referenced class's own file is located by Rails' constant-to-path convention and read for its declared return type. Discovered units become `RawCodeStructure` objects handed to `@suss/extractor`'s `assembleSummary`, the same assembly code the other adapters use.

v0 (this slice) reads graphql-ruby only: `routes.rb` is a separate, much larger macro-expansion problem, which the [language-adapters proposal](../../../design/proposals/language-adapters.md) costs out and leaves for later. `require` is not resolved; class and module nesting is. A resolver's transitions are always empty (`branches: []`), since v0 does no path-engine work, and confidence is pinned low.

## The method behind a field

Most fields in a graphql-ruby schema get their value from a method. A summary should say a field has nothing behind it only when the adapter looked and found no such method.

The library calls a field's method with `public_send`, so that method can be written anywhere in the class's ancestry. `ancestry.ts` walks the chain, finding each ancestor by the same constant-to-path convention that a `mutation:` or `resolver:` reference already uses. A plain field gets its value from a method of the same name somewhere along that chain. A wired field gets its value from the `resolve` method somewhere along the wired class's chain. graphql-ruby decides which method name a wired class uses, so the pack says which one in `resolverMethodName`. It also says where a project's chain ends: `ancestryRootClassNames` lists the library's own root classes, and reaching one means the walk got past everything the project defined.

The walk produces the same order Ruby does. Ruby builds a class's ancestors as each `include` runs. It works out the included module's own chain first, inserts that chain as a unit, skips anything already in the ancestors, and never moves a module that an earlier include or the superclass already placed. Two concerns sharing a base give `[C, B, A, Base]` rather than `[C, B, Base, A]`, and a base that the superclass already mixes in stays after the superclass. So the walk builds the superclass chain first, filters every later step against what is already there, and expands each sibling include on its own rather than descending into it with the set the siblings share. `include A, B` mixes in B before A, while `include A` followed by `include B` puts B first, so the walk reads calls in source order and reads a single call's arguments backwards.

The tests check this behavior, and the linearization itself was compared against `Module#ancestors` in a running Ruby process for a diamond, a three-way diamond, a diamond crossing a superclass boundary, `prepend`, multi-argument `include`, a module included twice, and a nested module chain.

The same walk builds the declared contract, reading the most distant ancestor first, so a mutation that inherits `argument` declarations from a base mutation gets them.

What the summary then says:

- When the walk finds a method, `bodyContent` comes from that method's body. Nothing in the body matches a shape this pack looks for, so the extractor falls back to its own sentence: what the field does is not described here.
- When the walk reads a field's whole ancestry and finds no such method, `bodyContent` stays `"absent"` and the summary keeps its no-body sentence. That is right for such a field, because the library gets its value by reading the attribute off the object the field was resolved against.
- When the walk stops early, `bodyContent` stays unset and the summary gets one sentence saying what stopped it: an ancestor whose file the convention cannot locate, a `define_method` call that defines methods a reader of `def` nodes cannot see, or a wiring value that is not a constant path. `bodyContent` stays unset because the extractor writes its own sentence from that field, and any value would be a claim this reader cannot make. The walk does not read `method_missing` either.

An ancestor the reader could not open stops the search, rather than the search continuing to a method further along. Ruby would have called whatever that ancestor defines, so a method found past it is not the one that runs, and reporting it would be a confident wrong claim instead of an abstention.

What a body does still goes unread. Reading it needs the path engine: statements to walk, a return value to turn into a shape, and calls to resolve against something that knows what they return. `RawCodeStructure.dependencyCalls` is no shortcut around that, because nothing in the summary assembly reads it. A field's location also stays where the field is declared rather than moving to a resolver method in another file, so the path and line numbers on a summary keep pointing at the same place.

One thing the walk deliberately leaves out. A `field` declared on a base object type is not discovered on its subclasses. That would change which units exist rather than what each one says about itself, and it is a separate piece of work.

## What a body lowers to

The adapter lowers a method body into the statement form the shared path
engine in `@suss/extractor` walks, the same engine the Python and TypeScript
adapters use. It is generic over the language's own condition handle and never
looks inside one, so the enumeration and the negation of an earlier arm are
shared rather than written again here.

| Ruby | Lowers to |
| --- | --- |
| `if` / `elsif` / `else`, `unless` | one `if` per test, with the elsif chain nested into the else arm |
| `while`, `until`, `for` | `loop` |
| a call with a `do` block, such as `items.each do \|i\|` | `loop`, because the block runs per iteration |
| `begin` / `rescue` / `ensure` | `try` |
| `case` / `when` / `else` | `switch`, with `else` as the default group |
| `return`, `raise`, `break`, `next` | `exit` |
| anything else | `opaque` |

Three things read differently from Python, and each one is why this file
exists rather than a shared lowering:

- **`raise` is an ordinary method call**, not a keyword, so a throw is
  recognised by the call's name rather than by a node type.
- **A `return` inside a `do` block returns from the method**, so the scan
  descends into one. A lambda captures its own return, so the scan stops
  there.
- **A method returns its last expression** with no `return` written, which
  Python has no equivalent of.

### Keying anything on a node

tree-sitter hands back a fresh wrapper object every time a child is read, so
two reads of one node are never `===` and a plain `Set` or `Map` keyed on a
node matches nothing. Use `NodeSet` and `NodeMap`, which key on the node id.
`npm run check:style` fails a build that keys either on a node.

## Finding the definition behind a constant

Ruby has no imports. A file says `require` to load another file, and after
that every constant either one defines is reachable by name, so which file a
name came from is settled by where the constant is defined rather than by
anything written at the reading site. The other two adapters emit `imports`
and this one binds a reference straight to its definition.

Lookup follows Ruby's own rule. A name written inside `module Types; class
Wrapper` is looked for as `Types::Wrapper::Order`, then `Types::Order`, then
`Order`, and the first one that settles wins:

```ruby
module Types
  class Order; end
  class Wrapper
    def build
      Order      # Types::Order, not the top-level one
    end
  end
end
```

A name two files define under the same nesting says nothing, because choosing
between them would be a guess. Neither does a constant built at run time
through `const_set` or `Object.const_get`, which nothing here reads.

The definitions are collected per file and matched afterwards, since which
file defines a constant is only settled once every file has been read.

## What a class inherits

A class says which class it extends, twice. `extends` points at whatever the
superclass name binds to, so the shared rules find a method a base class
declares on a subclass that never overrode it. `extendsNamed` keeps the name
as written, because a base class the project does not declare, like
`ActiveRecord::Base`, has no node in the run to point at:

```ruby
class Order < ApplicationRecord
end
```

```
extends       order.rb:0-31  order.rb#ApplicationRecord
extendsNamed  order.rb:0-31  ApplicationRecord
```

A pack matching a library base class reads the second one, and follows the
first to keep going up.

## What a body does with the database

Ruby writes no return type, so the Python adapter's trick of reading what a
method says it gives back has no counterpart here. A pack says which base
class the library gives a model instead:

```ts
storage: [
  {
    baseClasses: ["ActiveRecord::Base"],
    writes: ["update", "destroy", "save", "create", "delete_all"],
    storageSystem: "postgresql",
  },
]
```

A call matches when the constant its receivers start at reaches one of those
base classes. Rails puts its own class in between, and following `extends`
through the project and matching `extendsNamed` at the library takes care of
that:

```ruby
class ApplicationRecord < ActiveRecord::Base; end
class Order < ApplicationRecord; end

Order.where(id: 1).first   # one read, against Order, picking rows by id
```

A chain is one thing the code does, so that counts once. The method the chain
ends with tells a read from a write, and the keywords along it become the
selector. `fields` comes back empty, and a call on anything that is not a
constant says nothing, since there is no class to ask about.

## Where it fits in suss

Depends on `@suss/extractor` (for `RawCodeStructure` / `assembleSummary`), `@suss/behavioral-ir`, `@suss/datalog` (for the fact database), and `web-tree-sitter`. Framework packs under `packages/framework/*` (starting with `@suss/framework-graphql-ruby`) consume its `RubyPack` contract; nothing in this package knows what any particular library's classes or DSL calls are named beyond graphql-ruby's own `field` / `argument` / `type` verbs, which the discovery logic reads structurally rather than through pack configuration.

## Grammar asset

`grammar/tree-sitter-ruby.wasm` is a checked-in binary asset, not a build output. See [`grammar/README.md`](./grammar/README.md) for its provenance and how to bump it.

## Coverage

![coverage](../../../.github/badges/coverage-ruby.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).
