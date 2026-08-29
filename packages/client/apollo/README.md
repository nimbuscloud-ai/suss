# @suss/client-apollo

Client pack for [Apollo Client](https://www.apollographql.com/docs/react/). Every GraphQL operation a frontend or a script sends becomes a `client`-kind summary bound to a `graphql-operation(operationType, operationName?)` boundary.

## What this package is

`@suss/client-apollo` returns a `PatternPack` object describing:

- **Discovery** of hook calls against `@apollo/client` and `@apollo/client/react`: `useQuery`, `useLazyQuery`, `useSuspenseQuery`, `useBackgroundQuery`, `useLoadableQuery`, `useMutation`, and `useSubscription`. The query hooks differ in when they run and how they suspend rather than in what they ask the server for, so all of them produce the same boundary. The list goes by signature, so a hook missing from it is a hook the pack does not see rather than one that is not a boundary.
- **Discovery** of imperative calls: `client.query`, `client.mutate`, and `client.subscribe`, which is what server-side data fetching, `getServerSideProps`, and Node scripts use. The client identifier can have any name, and the pack gates on `ApolloClient` being imported so an unrelated `.query()` does not light up.
- **Client constructions** the operations go through: `ApolloClient`, `HttpLink`, and `createHttpLink`, each read for its `uri` option. `createFragmentRegistry` handed to `InMemoryCache`'s `fragments` option is read too, so a document can spread a fragment it does not define.
- **Terminals**: `return` and `throw`.

The pack sets `protocol: "http"`. Subscriptions are reported through `operationType`, and the transport tag stays `http` because the Apollo `HttpLink` is the default path.

### Resolving the document

The document argument resolves across the forms production codebases use: an inline `gql` tag or `gql(...)` tag call, a named constant holding either (same module, imported, or behind a re-export barrel), a `.graphql` or `.gql` file import, and a generated `TypedDocumentNode` object literal from graphql-codegen client-preset. A `${...}` interpolation resolves the same way and splices in, so a fragment-composed operation is read whole. A named constant is what most codebases write, and it resolves through the fact layer rather than by walking one variable declaration, so aliases and barrels do not hide the document.

Operation type and name come from the document body when it can be read, from the `TypedDocumentNode<Result, Vars>` type arguments when it cannot, and from the call itself (hook or method) as the last fallback. A document that stays unresolvable still produces the boundary, with `metadata.graphql.unresolvedDocument` on the summary. A spread whose definition never resolves shows up as `metadata.graphql.unresolvedFragments`.

Summary inputs come from the operation header's `$variables`, with role `variable`. The `variables: { ... }` call option is not read on its own, because the header is the authoritative variable declaration.

## Options

Both options tell the pack which service an operation talks to, for a frontend wired to more than one. Pass them to `apolloClientPack()`, or as JSON to `-f apollo-client=packs/apollo.json`.

```json
{
  "clients": {
    "import.meta.env.VITE_GRAPHQL_URL": "storefront-api",
    "https://payments.internal/graphql": "payments-api"
  },
  "operationScopes": [
    { "files": ["src/billing/**"], "workspace": "payments-api" }
  ]
}
```

- `clients`: which service each client talks to, keyed by the endpoint the client is constructed with. The key is the `uri` string itself, or the written expression when the value is computed, such as an env read like `import.meta.env.VITE_GRAPHQL_URL`. The value is the provider workspace name. One line per client separates two GraphQL services that share root field names.
- `operationScopes`: which service the operations in a set of files talk to. A hook call does not say which client it goes through, so these globs decide by file: an operation whose file matches gets the entry's workspace, and the first matching entry wins.

## Pairing

Provider-side summaries (Apollo resolvers, AppSync resolvers) will pair with these once the pairing layer grows operation-to-resolver selection-set mapping. Until then a `graphql-operation` binding lands in `unmatched`, which surfaces the consumer boundary without joining it.

## Where it fits in suss

Depends only on `@suss/extractor` (for the `PatternPack` type). Contains no analysis logic; the adapter does the document resolution the pack declares.

## Coverage

![coverage](../../../.github/badges/coverage-apollo-client.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how client packs work, see [`docs/packs.md`](../../../docs/packs.md).
