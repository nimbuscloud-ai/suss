# @suss/client-apollo

Client pack for [Apollo Client](https://www.apollographql.com/docs/react/). Every GraphQL operation a frontend or a script sends becomes a `client`-kind summary bound to a `graphql-operation(operationType, operationName?)` boundary.

```ts
const GET_USER = gql`
  query GetUser($id: ID!) {
    user(id: $id) { id name }
  }
`;

const { data } = useQuery(GET_USER, { variables: { id } });
```

## What this package is

`@suss/client-apollo` exports a `PatternPack`, which is data the adapter reads. It covers:

- **Discovery** of hook calls from `@apollo/client` and `@apollo/client/react`: `useQuery`, `useLazyQuery`, `useSuspenseQuery`, `useBackgroundQuery`, `useLoadableQuery`, `useMutation` and `useSubscription`. The query hooks differ in when they run and how they suspend, but they all ask the server for the same thing, so all of them produce the same boundary. These are the hooks that take a GraphQL document, and the pack matches each one by its imported name. A hook missing from the list is one the pack cannot see, even though it is still a boundary.
- **Discovery** of imperative calls: `client.query`, `client.mutate` and `client.subscribe`, which server-side data fetching, `getServerSideProps` and Node scripts use. The client variable can have any name. The pack only reads a file that imports `ApolloClient`, so an unrelated `.query()` is not picked up.
- **Client constructions** the operations go through: `ApolloClient`, `HttpLink` and `createHttpLink`, each read for its `uri` option. `createFragmentRegistry` passed to the `fragments` option of `InMemoryCache` is read too, so a document can spread a fragment it does not define.
- **Terminals**: `return` and `throw`.

The pack sets `protocol: "http"`. Subscriptions are recorded through `operationType`, and the transport stays `http` because Apollo's `HttpLink` is the default.

### Resolving the document

The document argument resolves in each of the ways production code writes it: an inline `gql` tag or `gql(...)` call; a named constant that contains either, whether in the same module, imported, or behind a re-exporting barrel; an import of a `.graphql` or `.gql` file; and a generated `TypedDocumentNode` object literal from the graphql-codegen client preset. A `${...}` interpolation resolves the same way and is spliced in, so an operation built from fragments is read whole. An interpolation that is a plain string instead of a document, which is how a shared field list is usually written, is spliced in as text. If the reader cannot settle an interpolation to a single value, it leaves the operation unread and records that in `metadata.graphql.unresolvedDocument`. Most code uses a named constant, and suss resolves it through the fact layer, which follows aliases and barrels, so neither hides the document.

The operation type and name come from the document body when it can be read. Otherwise they come from the `TypedDocumentNode<Result, Vars>` type arguments, and as a last resort from the call itself (the hook or method). A document that stays unresolved still produces the boundary, with `metadata.graphql.unresolvedDocument` on the summary. A spread whose definition never resolves shows up in `metadata.graphql.unresolvedFragments`.

A document built with the project's own generated tag is what graphql-codegen's client preset writes, imported as `~/__generated__/gql` or similar. In such a document, a bare `...UserCard` is resolved from the fragment the project defines elsewhere, since the build does the same. The definition goes into the stored document, so the fields selected through it get checked. The definitions come from every document the project writes as a tag, in any position, plus the `.graphql` and `.gql` files next to the source, which is the same set codegen reads. A document built with a library's tag (`@apollo/client`, `graphql-tag`) is read as written, because that is what ships, so a spread it does not define stays in `unresolvedFragments`. When the project defines one name more than once with different bodies, neither definition is used, and the name also appears in `metadata.graphql.ambiguousFragments`.

Summary inputs come from the `$variables` in the operation header, with role `variable`. The `variables: { ... }` call option is not read, because the header is where the variables are declared.

When a project hook passes its own document parameter to one of Apollo's hooks, suss reads it as one operation per caller, with the caller's document, at the caller's location. Most frontends have one `useAppQuery` that picks the client or adds telemetry, and every component calls it. That hook is not an operation by itself, so a summary for it would produce findings about nothing. The callers come from the resolution facts, which follow aliases and re-exporting barrels. A hook that calls another hook is followed up to the component at the top, three levels deep. Each operation is recorded in the component's own file, so `operationScopes` applies per caller. When a caller cannot be followed, because it is outside the run or because the document reaches the wrapper through something the facts do not cover, the hook keeps a summary of its own. Its `metadata.graphql.unresolvedDocument.reason` records how many callers were read and how many were not. A caller whose document is computed gets its own summary with that gap on it, the same as a direct hook call with an argument that cannot be read.

## Options

Both options tell the pack which service an operation talks to, for a frontend that uses more than one. Pass them to `apolloClientPack()`, or as JSON with `-f apollo-client=packs/apollo.json`.

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

- `clients`: which service each client talks to, keyed by the endpoint the client is constructed with. The key is the `uri` string itself, or the expression as written when the value is computed, such as an env read like `import.meta.env.VITE_GRAPHQL_URL`. The value is the provider workspace name. One line per client keeps apart two GraphQL services that share root field names.
- `operationScopes`: which service the operations in a set of files talk to. A hook call does not show which client it goes through, so these globs decide by file. An operation whose file matches gets the entry's workspace, and the first matching entry wins.

## Pairing

Provider-side summaries, such as Apollo resolvers and AppSync resolvers, will pair with these once the pairing layer can map an operation's selection set to resolvers. Until then a `graphql-operation` binding lands in `unmatched`, which shows the consumer boundary without joining it to anything.

## Where it fits in suss

The pack depends only on `@suss/extractor`, for the `PatternPack` type. It has no analysis logic of its own, and the adapter does the document resolution the pack declares.

## Coverage

![coverage](../../../.github/badges/coverage-apollo-client.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how client packs work, see [`docs/packs/what-a-pack-is.md`](../../../docs/packs/what-a-pack-is.md).
