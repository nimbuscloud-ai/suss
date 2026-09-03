# @suss/adapter-ruby

Ruby language adapter for suss. It parses source with tree-sitter (WASM), resolves constant nesting with its own lexical binder, and emits behavioral structure through the same shared assembly layer the Python and TypeScript adapters use.

## What this package is

`@suss/adapter-ruby` is the Ruby language adapter, per [`docs/internal/facts-and-rules.md`](../../../docs/internal/facts-and-rules.md)'s Layer 1 contract: discover units, emit summaries in the shared IR, emit facts. It parses a file with `web-tree-sitter` and a vendored Ruby grammar (`grammar/tree-sitter-ruby.wasm`, no native build step), tracks class/module nesting to qualify a constant the way Ruby itself would resolve it lexically, and discovers graphql-ruby's class-based `field` DSL on a class extending a pack-configured base class. A `field :x, mutation: Mutations::Y` or `field :x, resolver: Queries::Z` reference is followed one hop: the referenced class's own file is located by Rails' constant-to-path convention and read for its declared return type. Discovered units become `RawCodeStructure` objects handed to `@suss/extractor`'s `assembleSummary`, the same assembly code the other adapters use.

The adapter also discovers a `controllerActions` pattern: a class whose ancestry reaches a pack-configured base is a Rails-shaped controller, and each of its own public instance methods is one of its actions, bound to whatever method and path the pack's `routeFor` gives it. `@suss/framework-rails` is the pack that reads `config/routes.rb` and supplies that callback; the adapter itself contains no Rails string. `require` is not resolved; class and module nesting is. A resolver's transitions are always empty (`branches: []`), since a graphql field does no path-engine work, and confidence is pinned low.

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

## What a file reads from the environment

`ENV` is part of the language core, so the adapter recognizes reads of it
itself, without a pack. Each read becomes the same `config-read` interaction
the TypeScript adapter emits for `process.env.X`, on the binding
`runtime-config`, spelled `ENV["X"]` whichever way the source wrote it. The
runtime-config checker pairs those against what a template declares for the
process the file runs in.

| Ruby | Recognized as | Defaulted |
| --- | --- | --- |
| `ENV["X"]`, `ENV['X']`, `::ENV["X"]` | a read of `X` | no |
| `ENV.fetch("X")` | a read of `X` | no |
| `ENV.fetch("X", "d")`, `ENV.fetch("X", nil)` | a read of `X` | yes |
| `ENV.fetch("X") { "d" }`, `ENV.fetch("X") do ... end` | a read of `X` | yes |
| any of these followed by `\|\|` (`ENV["X"] \|\| "d"`) | a read of `X` | yes |
| `ENV[name]`, `ENV.fetch("#{prefix}_X")`, `ENV[:X]` | nothing: the name is not a string literal | |
| `ENV["X"] = "1"`, `ENV.key?("X")`, `Settings::ENV["X"]` | nothing: a write, a membership test, or another constant | |
| `other \|\| ENV["X"]` | `X` not defaulted, since it is the chain's last resort | |

A read inside a method a pack discovers (a resolver method behind a GraphQL
field) goes on that unit's summary. A read in the file body, in a class or
module body, or in a block at those levels runs when the file loads, so it goes
on a `module-init` summary named after the file, one per file that has such a
read. A read inside a method no pack discovers, or inside a lambda, is reported
nowhere, because nothing says when it runs.

## What a file depends on in the project

Every summary has `metadata.moduleImports`, the project files this file depends
on, relative to the workspace root and sorted. Ruby has no import statement, so
the list comes from two places: a `require_relative` whose target is a file in
the run, and a constant the file references that another file in the run
defines (`Settings::REGION` puts the file defining `Settings` in the list). A
plain `require` is not followed, because where it loads from depends on the
load path at run time. A file that depends on nothing in the project gets an
empty list rather than no field, so a Lambda handler that only requires gems
still tells the checker that its closure is the handler file alone.

## What a field's resolver reaches

A field's resolver method calls project methods, and those call others. Each method the field reaches this way gets a summary of its own, of kind `library`, bound as `function-call` with `transport: "in-process"` and `recognition: "reachable"`, with the calls, environment reads and database work its own body does. Each invocation effect on a field or a reached method says which summary the call lands on, in `summary`, so a reader answering "what does this field reach" follows `summary` from one unit to the next and never has to match a name.

The walk starts at the resolver method behind every discovered field (the one the section above finds), and adds a `calls` fact for each call in a body it could follow, until the set stops growing. A method two actions both reach gets one summary. A call the walk could not follow is recorded once per callee on the summary of the body it is in, as an `unfollowedCall` gap saying why, unless the reason is one nothing could have done better with (a call into a gem, a call through a parameter that some caller passes a method by name into, or one with no declaration this reader could find).

Ruby has no lexical binder for a local variable, so a callee is only followed when the source spells out where it goes: through the class ancestry `ancestry.ts` already computes, through a method the project writes outside any class, which Ruby mixes into every object as a private method, or through a method passed by name into the parameter that calls it.

| Written as | Followed to |
| --- | --- |
| `helper` or `self.helper`, called bare in a method | that method in the enclosing class's own ancestry |
| `helper`, when nothing in the enclosing ancestry defines it | `def helper` written outside any class, project-wide |
| `Service.new.method` | `method` in `Service`'s own ancestry |
| `Service.method` | `def self.method` written in `Service`'s own body |
| `register(method(:build_index))`, where `register(handler)` calls `handler.call` or `handler.()` | `build_index`, followed from wherever a caller in the run named it, through the parameter `register`'s own body calls |

A method passed by name into a call is followed one hop further than the call itself. `method(:build_index)`, written bare with no receiver, is Ruby's way of naming a method rather than calling it, and only that bare form is followed; a `self.method(:build_index)` written with an explicit receiver is not. The same reference works as an `&`-prefixed block argument, `register(&method(:build_index))`, and is numbered by its position among the call's arguments, same as any other argument: `&method(...)` occupies whatever slot it is written in, and a receiving method's own `&blk` parameter is counted at its own declared position among that method's parameters, so the two line up without a separate convention for the block slot. `handler.call` (with or without parentheses) and the `handler.()` shorthand both invoke a `Proc` or `Method` a parameter is bound to, and are recognized the same way; a plain block passed with `do...end` or `{ }`, and `yield`, are not, so a resolver that only ever receives its block that way still gets `unboundParameter` on the call, with no join to fill it.

Where it stops, and what the gap says:

| Written as | Reason |
| --- | --- |
| `obj.send(:method)`, `public_send`, `__send__` | a dynamic send this run does not follow |
| a method the project writes with `define_method` | a body this reader cannot see |
| a bare name two files each define at the top level | more than one possible source |
| `Rails.cache.delete`, a call into a class this run does not define | outside the run (no gap) |
| `user.orders`, a local variable, or an instance variable | the value could not be settled |
| `handler.call` or `handler.()`, where `handler` is a parameter that some caller in the run passes a method by name into | followed through the join above (no gap) |
| `handler.call` or `handler.()`, where `handler` is a parameter that no caller in the run passes a method by name into | the caller supplies it, and nothing named what it passed |
| `service_class.new.method` where `service_class` is not a constant | the value could not be settled |

Not followed yet: a method found only on a superclass past an unread ancestor, a callable read out of a variable, the body of a block passed to `define_method`, and `yield`.

## Where it fits in suss

Depends on `@suss/extractor` (for `RawCodeStructure` / `assembleSummary`), `@suss/behavioral-ir`, `@suss/datalog` (for the fact database), and `web-tree-sitter`. Framework packs under `packages/framework/*` (`@suss/framework-graphql-ruby` and `@suss/framework-rails`) consume its `RubyPack` contract; nothing in this package knows what any particular library's classes, DSL calls, or base classes are called beyond graphql-ruby's own `field` / `argument` / `type` verbs, which the discovery logic reads structurally rather than through pack configuration.

## Grammar asset

`grammar/tree-sitter-ruby.wasm` is a checked-in binary asset, not a build output. See [`grammar/README.md`](./grammar/README.md) for its provenance and how to bump it.

## Coverage

![coverage](../../../.github/badges/coverage-ruby.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).
