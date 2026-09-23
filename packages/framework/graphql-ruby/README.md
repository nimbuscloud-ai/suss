# @suss/framework-graphql-ruby

Framework pack for [graphql-ruby](https://graphql-ruby.org/)'s class-based field DSL, read by the Ruby adapter.

```ruby
module Types
  class CampaignType < Types::BaseObject
    field :name, String, null: false
    field :launch, mutation: Mutations::LaunchCampaign
  end
end
```

## What this package is

`@suss/framework-graphql-ruby` exports a `RubyPack`. It covers:

- **Discovery**: a class that extends a configured base class, whose body declares `field :name, Type, null: ...` calls. The base classes are graphql-ruby's own generated `Types::BaseObject` and any a project lists. Each field becomes its own resolver, keyed by `(typeName, fieldName)`. `typeName` is the class's short name with a trailing `Type` removed, which is graphql-ruby's default naming, so `Types::CampaignType` comes out as `Campaign`.
- **`mutation:` and `resolver:` wiring**: `field :x, mutation: Mutations::Y` and `field :x, resolver: Queries::Z` take their return type and arguments from the referenced class's own file. The pack finds that file under `root` by Rails' convention for mapping a constant to a path.
- **Boundary bindings**: `graphql-resolver(typeName, fieldName)`, which pairs with a client operation the same way any other graphql-resolver summary does.
- **camelCase naming**: graphql-ruby exposes a `field` or `argument` symbol's snake_case name in camelCase on the schema by default. The pack's `camelize` option sets that default for the whole schema, and is `true` to match the library. A `field` or `argument` call's own `camelize: false` keyword overrides the default for that one name, the same as it does at run time.
- **Reads through the dataloader**: `dataloader.with(Sources::Record, ::User).load(id)`, and the `dataload`, `dataload_all`, `dataload_record` and `dataload_all_records` shortcuts, are reads of the model they are given. That needs a storage pack in the same run (`@suss/framework-activerecord`) that recognizes the constant as a model. On its own this pack records nothing for them. `dataload_association` is not read, since the model behind an association is declared somewhere else.

## Where it fits in suss

The pack depends only on `@suss/adapter-ruby`, for the `RubyPack` type and the Ruby extraction pipeline. It has no analysis logic of its own.

## v0 scope

The pack reads only what a class declares. A resolver's transitions are always empty (`branches: []`), and confidence is fixed at low, as set out in [`design/proposals/language-adapters.md`](../../../design/proposals/language-adapters.md). `routes.rb` is a separate and much larger macro-expansion problem, which the same document estimates, and it stays out of scope here.

## Configuration

```ts
import { graphqlRubyFramework } from "@suss/framework-graphql-ruby";

const pack = graphqlRubyFramework({
  root: path.join(repoRoot, "app/graphql"),
  // A schema that turns off graphql-ruby's own camelCase default:
  camelize: false,
});
```

The defaults cover every type-level base class that `rails g graphql:install`
generates, including the interface base. The adapter follows a class's
whole ancestry, so a project base class between a type and
`Types::BaseObject` needs no configuration. A base the walk cannot trace
to a generated one, such as a base a gem defines under another name,
goes in a dependency stub under `suss/stubs/`:

```yaml
# suss/stubs/acme-graphql.yaml
package: acme-graphql
statements:
  - kind: extends-base
    class: Acme::GraphQL::AuthenticatedObject
    extends: Acme::GraphQL::BaseObject
```

The pack then reads a class that extends `Acme::GraphQL::AuthenticatedObject`
as a set of resolvers. The `baseClassNames` pack option did the same job
until 0.21.0 removed it. A config file that sets it now stops the run and
points here.

`suss infer stub acme-graphql` reads the project's own `require`s and
class definitions, and drafts one `extends-base` statement for each
superclass it finds that comes from the package. A class that extends
one of graphql-ruby's own root classes directly is skipped, since the
pack already stops there and a stub would add nothing.

## Coverage

![coverage](../../../.github/badges/coverage-graphql-ruby.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).
