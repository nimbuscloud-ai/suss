# @suss/framework-apollo

Framework pack for [Apollo Server](https://www.apollographql.com/docs/apollo-server/) resolvers, written code-first. It finds the resolver functions attached to an `ApolloServer` config object and gives each one a `graphql-resolver(typeName, fieldName)` boundary binding.

## What this package is

`@suss/framework-apollo` returns a `PatternPack` object describing:

- **Discovery** of the `resolvers` map handed to `new ApolloServer({ ... })`. Every inner property of that map becomes a `resolver` unit. Three modules are covered: `@apollo/server` for v4, plus `apollo-server` and `apollo-server-express` for the versions before it, which use the same shape under a different name.
- **Terminals**: a `return`, a `throw` (Apollo turns a thrown error into an entry in `errors[]` on the outgoing response), and a resolver that falls off the end of its body without returning.
- **Input mapping**: the four positional parameters `(parent, args, context, info)`, each with its role, so a downstream check can tell a resolver that reads `args` from one that delegates to `context`.

The pack declares `http` as its protocol, because that is what Apollo Server runs over. The GraphQL part of the identity is discriminated at the resolver level and rides on the binding.

## Not covered yet

- Schema-first wiring, where resolvers reach the schema through `addResolversToSchema` or `makeExecutableSchema`. That needs its own discovery pattern.
- A resolver map some function returns, such as `mergeResolvers(...)`. A map put together by writing out objects and spreading them reads fine, whichever module each part was written in, because the adapter follows the identifiers. A map a function returns has no written form to follow.
- The `{ subscribe, resolve }` form of a subscription resolver. Only the plain function form is discovered.

## Where it fits in suss

Depends only on `@suss/extractor` (for the `PatternPack` type). Contains no analysis logic.

## Coverage

![coverage](../../../.github/badges/coverage-apollo.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how framework packs work, see [`docs/packs.md`](../../../docs/packs.md).
