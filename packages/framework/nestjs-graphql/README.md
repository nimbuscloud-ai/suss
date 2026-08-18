# @suss/framework-nestjs-graphql

Framework pack for [`@nestjs/graphql`](https://docs.nestjs.com/graphql/quick-start) resolvers, read by the TypeScript adapter.

## What this package is

`@suss/framework-nestjs-graphql` returns a `PatternPack` describing:

- **Discovery**: a class decorated with `@Resolver()` whose methods carry `@Query`, `@Mutation`, `@ResolveField`, or `@Subscription`. NestJS wires resolvers internally, so there is no `new ApolloServer({ resolvers: {...} })` call for the resolver-map discovery in `@suss/framework-apollo` to find.
- **Boundary bindings**: `graphql-resolver(typeName, fieldName)`, pairing against a client operation the same way any other graphql-resolver summary does.
- **Terminals**: a resolver returns a value, and errors propagate as thrown exceptions that NestJS and Apollo turn into `errors[]` on the outgoing response.
- **Inputs**: `@Args()`, `@Parent()`, `@Context()`, and `@Info()` map to the (parent, args, context, info) tuple Apollo passes positionally. Each parameter's first matching decorator decides its role.

## Which type owns a field

This is the part that is easy to get backwards, and getting it backwards puts every root operation under the wrong type.

The **method** decorator decides the type whenever it can:

```ts
@Resolver(() => User)
export class UserResolver {
  @Query(() => User) findUser() {}      // Query.findUser
  @Mutation(() => User) createUser() {} // Mutation.createUser
  @ResolveField(() => Workspace) workspace() {} // User.workspace
}
```

`@Query` puts its field on the root `Query` type, `@Mutation` on `Mutation`, and `@Subscription` on `Subscription`, whatever the class decorator says. `@Resolver(() => User)` is there for `@ResolveField`: it says which type those members resolve fields on. It never applies to a root operation.

Reading the class argument as the type for every member is what suss did until v0.9.1. It filed `findUser` under `User`, so a client asking for `Query.findUser` paired with nothing, and the summary came out with a `boundaryFieldUnknown` finding against it.

A `@ResolveField` on a class with no argument has nothing left to read its type from. The binding then has no type, the summary gets a gap saying so, and nothing pairs with it. NestJS rejects that class at startup; suss reports what it could not read rather than picking a root operation type and claiming a field the schema does not have.

## Field naming

The field name comes from the method decorator's `name` option when it is set (`@Query(() => User, { name: "lookupUser" })`), and otherwise from the method's own name.

## Where it fits in suss

Depends only on `@suss/extractor`, for the `PatternPack` type. Contains no analysis logic of its own.

## Configuration

```ts
import { nestjsGraphqlFramework } from "@suss/framework-nestjs-graphql";

const pack = nestjsGraphqlFramework({
  // A wrapper around `@Resolver()` whose body is not in your project:
  classDecorators: ["TenantResolver"],
});
```

A wrapper written in the project needs no entry here. The adapter resolves a class decorator to the function behind it and accepts it when calling that function calls `Resolver` from `@nestjs/graphql`. `classDecorators` is for a wrapper whose body is somewhere the adapter cannot read.

## v0 scope

- **`@Args('field')` shape.** Every `@Args` lands as a single `args` input. Decomposing the field path and the type options is enough for the binding identity, and pairing that wants per-argument shape needs a richer decorator-argument parse.
- **Class inheritance and mixins.** Resolvers split across an abstract base and a concrete child are discovered separately, and pairing does not collapse them.
- **Decorator factories.** A custom decorator defined through `createParamDecorator(...)` bypasses the role map.

## Coverage

![coverage](../../../.github/badges/coverage-nestjs-graphql.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).
