// @suss/client-apollo — PatternPack for @apollo/client.
//
// Each `useQuery` / `useMutation` / `useSubscription` hook call and each
// imperative `client.query` / `client.mutate` / `client.subscribe` call
// becomes a `client`-kind BehavioralSummary bound to a
// `graphql-operation(operationType, operationName?)` boundary.
//
// The document argument resolves across the shapes production codebases
// use: an inline `gql` tag or `gql(...)` tag call, a named constant
// holding either (same module, imported, or behind a re-export barrel),
// a `.graphql` / `.gql` file import, and a generated
// `TypedDocumentNode` object literal from graphql-codegen client-preset.
// A named constant is what most codebases write, and it resolves
// through the fact layer rather than by walking one variable
// declaration, so aliases and barrels do not hide the document.
// Operation type + name come from the document body when readable, from
// the `TypedDocumentNode<Result, Vars>` type arguments when it isn't,
// and from the call shape (hook / method) as the final fallback. A
// document that stays unresolvable surfaces on the summary as
// `metadata.graphql.unresolvedDocument` — the boundary is still emitted.
//
// Operation-header `$variables` become summary inputs with role
// "variable"; the `variables: { ... }` call option isn't read on its
// own (the header is the authoritative variable declaration).
//
// Pairs with provider-side summaries (Apollo resolvers, AppSync
// resolvers) when the pairing layer grows operation→resolver
// selection-set mapping. Until then, graphql-operation bindings land
// in `unmatched` rather than pairing automatically — surfacing the
// consumer boundary, not joining it.

import type { PatternPack } from "@suss/extractor";

/**
 * The Apollo hooks this pack reads a document off. Each takes the
 * document as its first argument, and the query hooks differ in when
 * they run and how they suspend rather than in what they ask the server
 * for, so each one is the same boundary. `useLazyQuery` in particular is
 * what a component reaches for whenever the query runs on an event
 * rather than on render, which makes it as common as `useQuery` itself.
 *
 * The list is by signature and Apollo can add to it, so a hook missing
 * here is a hook the pack does not see rather than a hook that is not a
 * boundary.
 */
const DOCUMENT_HOOKS = [
  { hookName: "useQuery", operationType: "query" },
  { hookName: "useLazyQuery", operationType: "query" },
  { hookName: "useSuspenseQuery", operationType: "query" },
  { hookName: "useBackgroundQuery", operationType: "query" },
  { hookName: "useLoadableQuery", operationType: "query" },
  { hookName: "useMutation", operationType: "mutation" },
  { hookName: "useSubscription", operationType: "subscription" },
] as const;

export function apolloClientPack(): PatternPack {
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
          hooks: [...DOCUMENT_HOOKS],
        },
        // Prefix match: covers `@apollo/client` AND `@apollo/client/react`
        // AND `@apollo/client/...` sub-paths in one go. The `importModule`
        // on the match itself stays exact-match for discovery's own
        // gating.
        requiresImport: ["@apollo/client"],
      },
      // Newer re-exports split per-runtime ("@apollo/client/react").
      // Apollo's current stable major is one path; the react-only
      // export is here to handle projects that pin per-runtime.
      {
        kind: "client",
        match: {
          type: "graphqlHookCall",
          importModule: "@apollo/client/react",
          hooks: [...DOCUMENT_HOOKS],
        },
        requiresImport: ["@apollo/client"],
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
        requiresImport: ["@apollo/client"],
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
      // Apollo hooks take no positional params we track — the surface
      // inputs are the operation-header `$variables`, which the adapter
      // reads from the resolved document and stamps onto the summary
      // directly (role "variable"), independent of this mapping.
      type: "positionalParams",
      params: [],
    },
  };
}

export default apolloClientPack;
