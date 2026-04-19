// @suss/runtime-apollo-client — PatternPack for @apollo/client hooks.
//
// Each call to `useQuery` / `useMutation` / `useSubscription` becomes
// a `client`-kind BehavioralSummary bound to a
// `graphql-operation(operationType, operationName?)` boundary. The
// adapter extracts the operation header by parsing the first
// argument's gql-tagged template literal — directly inline or
// resolved through one const-binding of an identifier.
//
// Pairs with provider-side summaries (Apollo resolvers, AppSync
// resolvers) when the pairing layer grows operation→resolver
// selection-set mapping. Until then, graphql-operation bindings land
// in `unmatched` rather than pairing automatically — v0 is about
// surfacing the consumer boundary, not joining it.
//
// Deferred:
//   - Imperative `client.query({ query })` / `client.mutate(...)`.
//     Structurally different from hooks; a follow-up once a concrete
//     consumer codebase exercises it.
//   - `.graphql` files imported via build loaders.
//   - Variables → structured inputs (v0 doesn't yet capture the
//     `variables: { ... }` option's shape as summary inputs).

import type { PatternPack } from "@suss/extractor";

export function apolloClientRuntime(): PatternPack {
  return {
    name: "apollo-client",
    languages: ["typescript", "javascript"],
    // Apollo Client sits over HTTP (or WebSocket for subscriptions;
    // subscriptions reported separately via operationType but the
    // transport tag stays "http" for v0 — the Apollo HttpLink is the
    // default path).
    protocol: "http",

    discovery: [
      {
        kind: "client",
        match: {
          type: "graphqlHookCall",
          importModule: "@apollo/client",
          hookNames: ["useQuery", "useMutation", "useSubscription"],
        },
      },
      // Newer re-exports split per-runtime ("@apollo/client/react").
      // Apollo's current stable major is one path; the react-only
      // export is here to handle projects that pin per-runtime.
      {
        kind: "client",
        match: {
          type: "graphqlHookCall",
          importModule: "@apollo/client/react",
          hookNames: ["useQuery", "useMutation", "useSubscription"],
        },
      },
      // Imperative client — covers server-side data fetching,
      // Next.js getServerSideProps, Node scripts, anywhere calling
      // `client.query(...)` / `client.mutate(...)` directly rather
      // than via a hook. The client identifier can be any name —
      // we gate on the `ApolloClient` constructor being imported
      // so random `.query()` method calls in unrelated code don't
      // light up.
      {
        kind: "client",
        match: {
          type: "graphqlImperativeCall",
          importModule: "@apollo/client",
          importName: "ApolloClient",
          methods: [
            {
              methodName: "query",
              documentKey: "query",
              operationType: "query",
            },
            {
              methodName: "mutate",
              documentKey: "mutation",
              operationType: "mutation",
            },
            {
              methodName: "subscribe",
              documentKey: "query",
              operationType: "subscription",
            },
          ],
        },
      },
    ],

    terminals: [
      {
        kind: "return",
        match: { type: "returnStatement" },
        extraction: {},
      },
      {
        kind: "throw",
        match: { type: "throwExpression" },
        extraction: {},
      },
    ],

    inputMapping: {
      // Apollo hooks don't take positional params we care about —
      // the surface inputs come from variables passed via the hook
      // options. Capturing variables structurally is Phase B.4.5
      // follow-up.
      type: "positionalParams",
      params: [],
    },
  };
}

export default apolloClientRuntime;
