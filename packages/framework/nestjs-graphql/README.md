# @suss/framework-nestjs-graphql

Framework pack for [`@nestjs/graphql`](https://docs.nestjs.com/graphql/quick-start) resolvers, read by the TypeScript adapter.

## What this package is

`@suss/framework-nestjs-graphql` exports a `PatternPack`. It covers:

- **Discovery**: a class decorated with `@Resolver()` whose methods have `@Query`, `@Mutation`, `@ResolveField` or `@Subscription`. NestJS wires resolvers internally, so there is no `new ApolloServer({ resolvers: {...} })` call for the resolver-map discovery in `@suss/framework-apollo` to find.
- **Boundary bindings**: `graphql-resolver(typeName, fieldName)`, which pairs with a client operation the same way any other graphql-resolver summary does.
- **Terminals**: a resolver returns a value. Errors propagate as thrown exceptions, which NestJS and Apollo turn into `errors[]` on the response.
- **Inputs**: `@Args()`, `@Parent()`, `@Context()` and `@Info()` map to the (parent, args, context, info) tuple Apollo passes positionally. The first matching decorator on a parameter decides its role.

## Which type a field belongs to

This is easy to get backwards, and getting it backwards puts every root operation under the wrong type.

The **method** decorator decides the type whenever it can:

```ts
@Resolver(() => User)
export class UserResolver {
  @Query(() => User) findUser() {}      // Query.findUser
  @Mutation(() => User) createUser() {} // Mutation.createUser
  @ResolveField(() => Workspace) workspace() {} // User.workspace
}
```

`@Query` puts its field on the root `Query` type, `@Mutation` on `Mutation`, and `@Subscription` on `Subscription`, whatever the class decorator says. `@Resolver(() => User)` is there for `@ResolveField`, and gives the type those members resolve fields on. It never applies to a root operation.

Until v0.9.1, suss read the class argument as the type for every member. It filed `findUser` under `User`, so a client asking for `Query.findUser` paired with nothing, and the summary got a `boundaryFieldUnknown` finding against it.

A `@ResolveField` on a class with no argument has nowhere else to get its type from. The binding then has no type, the summary gets a gap saying so, and nothing pairs with it. NestJS rejects that class at startup. suss reports what it could not read, and does not pick a root operation type and claim a field the schema does not have.

## Field naming

The field name comes from the method decorator's `name` option when it is set (`@Query(() => User, { name: "lookupUser" })`), and otherwise from the method's own name.

## Where it fits in suss

The pack depends only on `@suss/extractor`, for the `PatternPack` type. It has no analysis logic of its own.

## Configuration

If a wrapper around `@Resolver()` has its body outside your project, declare it in a dependency stub under `suss/stubs/`:

```yaml
# suss/stubs/acme-graphql-kit.yaml
package: "@acme/graphql-kit"
statements:
  - kind: composes-decorator
    export: TenantResolver
    composes: { module: "@nestjs/graphql", name: Resolver }
```

A wrapper written in the project needs no statement. The adapter resolves a class decorator to the function behind it, and accepts it when that function calls `Resolver` from `@nestjs/graphql`. A stub is for a wrapper whose body the adapter cannot read.

The `classDecorators` pack option did the same job until 0.21.0 removed it. A config file that sets it now stops the run and points here.

## v0 scope

- **`@Args('field')`.** Every `@Args` lands as a single `args` input. Decomposing the field path and the type options is enough for the binding identity. Pairing that wants the shape of each argument needs fuller parsing of decorator arguments.
- **Class inheritance and mixins.** Resolvers split across an abstract base and a concrete child are discovered separately, and pairing does not merge them.
- **Decorator factories.** A custom decorator built with `createParamDecorator(...)` is not in the role map.

## Coverage

![coverage](../../../.github/badges/coverage-nestjs-graphql.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).
