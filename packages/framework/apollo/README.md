# @suss/framework-apollo

Framework pack for [Apollo Server](https://www.apollographql.com/docs/apollo-server/) resolvers written code-first. It finds the resolver functions in the config object passed to `ApolloServer`, and gives each one a `graphql-resolver(typeName, fieldName)` boundary binding.

```ts
const server = new ApolloServer({
  typeDefs,
  resolvers: {
    Query: {
      order: (parent, args, context, info) => context.orders.find(args.id),
    },
  },
});
```

## What this package is

`@suss/framework-apollo` exports a `PatternPack`, which is data the adapter reads. It covers:

- **Discovery** of the `resolvers` map passed to `new ApolloServer({ ... })`. Every inner property of that map becomes a `resolver` unit. The pack covers three modules: `@apollo/server` for v4, and `apollo-server` and `apollo-server-express` for the versions before it, which use the same pattern under a different name.
- **Terminals**: a `return`, a `throw`, and a resolver that falls off the end of its body without returning. Apollo turns a thrown error into an entry in `errors[]` on the response.
- **Input mapping**: the four positional parameters `(parent, args, context, info)`, each with its role, so a later check can tell a resolver that reads `args` from one that hands off to `context`.

The pack declares `http` as its protocol, because Apollo Server runs over HTTP. The GraphQL part of the identity is set per resolver, on the binding.

## Not covered yet

- Schema-first wiring, where resolvers reach the schema through `addResolversToSchema` or `makeExecutableSchema`. That needs its own discovery pattern.
- A resolver map that a function returns, such as `mergeResolvers(...)`. A map built by writing out objects and spreading them works, whichever module each part is in, because the adapter follows the identifiers. A map a function returns has no written form for it to follow.
- The `{ subscribe, resolve }` form of a subscription resolver. Only the plain function form is discovered.

## Where it fits in suss

The pack depends only on `@suss/extractor`, for the `PatternPack` type. It has no analysis logic of its own.

## Coverage

![coverage](../../../.github/badges/coverage-apollo.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how framework packs work, see [`docs/packs/what-a-pack-is.md`](../../../docs/packs/what-a-pack-is.md).
