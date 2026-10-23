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
- **`mutation:` and `resolver:` wiring**: `field :x, mutation: Mutations::Y` and `field :x, resolver: Queries::Z` take their return type from the referenced class's `type` or `field` calls, and their arguments from its `argument` calls. The field's summary describes that class's `resolve` method. The class is found the way a call's receiver is, through the constants the run's files declare, so it can live outside `root`, in an engine or a pack directory. Only a class that no file in the run declares is looked for under `root`, by Rails' convention for mapping a constant to a path. This works on any object type, not only `Query` and `Mutation`.
- **`resolver_method:`**: `field :total, Integer, resolver_method: :count_all` is read from the type's `count_all` method instead of a method named `total`.
- **`ready?` and `authorized?`**: a Mutation or Resolver class runs `ready?`, then `authorized?`, then `resolve`. Each hook definition that runs gets a summary of its own, and the field lists it among its wrappers, the way a controller action lists a `before_action` filter. A hook that calls `super` runs the next definition along the ancestry too. A path through a hook that raises adds a throw to the field. A path that returns `false`, `nil`, or `false, payload` adds a return, since the field stops there and `resolve` never runs. Any other path lets the field go on.
- **RelayClassicMutation**: a mutation that extends `GraphQL::Schema::RelayClassicMutation`, directly or through a project base, takes one `input` argument on the wire. Its fields are the declared arguments plus `clientMutationId`.
- **Boundary bindings**: `graphql-resolver(typeName, fieldName)`, which pairs with a client operation the same way any other graphql-resolver summary does.
- **camelCase naming**: graphql-ruby exposes a `field` or `argument` symbol's snake_case name in camelCase on the schema by default. The pack's `camelize` option sets that default for the whole schema, and is `true` to match the library. A `field` or `argument` call's own `camelize: false` keyword overrides the default for that one name, the same as it does at run time.
- **Reads through the dataloader**: `dataloader.with(Sources::Record, ::User).load(id)`, and the `dataload`, `dataload_all`, `dataload_record` and `dataload_all_records` shortcuts, are reads of the model they are given. That needs a storage pack in the same run (`@suss/framework-activerecord`) that recognizes the constant as a model. On its own this pack records nothing for them. `dataload_association` is not read, since the model behind an association is declared somewhere else.

## Where it fits in suss

The pack depends only on `@suss/adapter-ruby`, for the `RubyPack` type and the Ruby extraction pipeline. It has no analysis logic of its own.

## What it does not read yet

- A hook path whose answer is worked out at run time, such as `context[:user].admin?`, is read as letting the field go on. Only an answer written out as `false` or `nil`, or a `return` with no value, stops the field.
- A raise inside `resolve` itself does not get a transition of its own. The field's one transition lists what `resolve` calls, reads and writes.
- `field :x, subscription: Subscriptions::Y` is not followed.
- graphql-ruby's own instance methods, such as `context` and `object`, are not declared as the library's, so a hook written in a module that calls `context` gets a gap saying the including class provides it.

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
