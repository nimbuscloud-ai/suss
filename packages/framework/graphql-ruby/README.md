# @suss/framework-graphql-ruby

Framework pack for [graphql-ruby](https://graphql-ruby.org/)'s class-based field DSL, read by the Ruby adapter.

## What this package is

`@suss/framework-graphql-ruby` returns a `RubyPack` object describing:

- **Discovery**: a class extending a configured base class (graphql-ruby's own generated `Types::BaseObject`, plus any a project lists) whose body declares `field :name, Type, null: ...` calls. Each becomes its own discovered resolver, keyed by `(typeName, fieldName)` where `typeName` is the class's own short name with a trailing `Type` stripped (graphql-ruby's own default naming: `Types::CampaignType` comes out as `Campaign`).
- **`mutation:` / `resolver:` wiring**: `field :x, mutation: Mutations::Y` and `field :x, resolver: Queries::Z` read their declared return type and arguments from the referenced class's own file, located by Rails' constant-to-path convention under `root`.
- **Boundary bindings**: `graphql-resolver(typeName, fieldName)`, pairing against a client operation the same way any other graphql-resolver summary does.
- **camelCase naming**: a `field`/`argument` symbol's snake_case name is exposed camelCased on the schema, graphql-ruby's own default. The pack's `camelize` option sets the schema-wide default (`true`, matching the library); a `field`/`argument` call's own `camelize: false` keyword overrides that default for that one name, the same as it does at runtime.

## Where it fits in suss

Depends only on `@suss/adapter-ruby` (for the `RubyPack` type and the Ruby-language extraction pipeline). Contains no analysis logic of its own.

## v0 scope

The pack reads only what a class declares: a resolver's transitions are always empty (`branches: []`), and confidence is pinned low, per [`design/proposals/language-adapters.md`](../../../design/proposals/language-adapters.md). `routes.rb` is a separate, much larger macro-expansion problem, which the same document costs out, and it stays out of scope here.

## Configuration

```ts
import { graphqlRubyFramework } from "@suss/framework-graphql-ruby";

const pack = graphqlRubyFramework({
  root: path.join(repoRoot, "app/graphql"),
  // A schema that turns off graphql-ruby's own camelCase default:
  camelize: false,
});
```

The defaults cover every type-level base class `rails g graphql:install`
generates, the interface base included, and the adapter follows a
class's whole ancestry, so a project base between a type and
`Types::BaseObject` needs nothing said about it. A base the walk cannot
reach a generated one from, such as one a gem defines under another
name, goes in a dependency stub under `suss/stubs/`:

```yaml
# suss/stubs/acme-graphql.yaml
package: acme-graphql
statements:
  - kind: extends-base
    class: Acme::GraphQL::AuthenticatedObject
    extends: Acme::GraphQL::BaseObject
```

The pack then reads a class extending `Acme::GraphQL::BaseObject` as a
set of resolvers. The `baseClassNames` pack option said the same thing
until 0.21.0 removed it. A config file setting it now stops the run and
points here.

## Coverage

![coverage](../../../.github/badges/coverage-graphql-ruby.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).
