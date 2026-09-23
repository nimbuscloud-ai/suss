/**
 * @suss/client-apollo: the pack for GraphQL operations sent with
 * `@apollo/client`.
 *
 * Each Apollo hook call, and each imperative `client.query`,
 * `client.mutate` or `client.subscribe` call, becomes a client summary
 * bound to a `graphql-operation(operationType, operationName?)`
 * boundary. The pack only declares where documents are passed. The
 * adapter resolves the document itself, and the README describes the
 * ways a document can be written and what happens when one stays
 * unresolved.
 */

import { z } from "zod";

import type { PatternPack } from "@suss/extractor";
import type { PackDeclaration } from "@suss/ir-core";

/**
 * Each of these hooks takes the document as its first argument. The
 * query hooks differ only in when they run and how they suspend, so they
 * all produce the same boundary. Apollo can add hooks, and a hook missing
 * from this list is still a boundary that the pack cannot see.
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

/**
 * The options in a `-f apollo-client=config.json` file. The CLI checks
 * the file against this schema before the pack factory runs.
 */
export const optionsSchema = z
  .object({
    /**
     * The provider workspace each client talks to, keyed by the endpoint
     * the client is constructed with. The key is the uri string, or the
     * expression as written when the value is computed, such as
     * `import.meta.env.VITE_GRAPHQL_URL`. One entry per client keeps
     * apart two GraphQL services that share root field names.
     */
    clients: z.record(z.string(), z.string()).optional(),
    /**
     * The workspace for operations in a set of files, for a frontend
     * that uses two clients. A hook call does not show which client it
     * goes through, so the pack decides by file. The first entry whose
     * globs match the operation's file wins.
     */
    operationScopes: z
      .array(
        z
          .object({ files: z.array(z.string()), workspace: z.string() })
          .strict(),
      )
      .optional(),
  })
  .strict();

export type ApolloClientPackOptions = z.infer<typeof optionsSchema>;

export function apolloClientPack(
  options: ApolloClientPackOptions = {},
): PatternPack {
  return {
    name: "apollo-client",
    languages: ["typescript", "javascript"],
    // Subscriptions can run over WebSocket, but operationType already
    // records them, and HttpLink is Apollo's default transport.
    protocol: "http",

    discovery: [
      {
        kind: "client",
        match: {
          type: "graphqlHookCall",
          importModule: "@apollo/client",
          hooks: [...DOCUMENT_HOOKS],
        },
        // requiresImport matches by prefix, so it also admits
        // `@apollo/client/react`. importModule above matches exactly.
        requiresImport: ["@apollo/client"],
      },
      // For projects that import the hooks from the React entry point.
      {
        kind: "client",
        match: {
          type: "graphqlHookCall",
          importModule: "@apollo/client/react",
          hooks: [...DOCUMENT_HOOKS],
        },
        requiresImport: ["@apollo/client"],
      },
      // `client.query(...)` outside a hook, as in server-side fetching.
      // The client variable can have any name, so the match requires an
      // `ApolloClient` import to skip unrelated `.query()` calls.
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

    // The endpoint an operation goes to comes from the `uri` option on
    // whichever of these built its client.
    graphqlClients: [
      {
        importModule: "@apollo/client",
        importName: "ApolloClient",
        uriProperty: "uri",
        // With a registry from `createFragmentRegistry` on the cache, a
        // document can spread a fragment it does not define, and the
        // client fills it in at run time.
        fragmentRegistry: {
          cacheProperty: "cache",
          cacheConstructor: {
            importModule: "@apollo/client",
            importName: "InMemoryCache",
          },
          registryProperty: "fragments",
        },
      },
      {
        importModule: "@apollo/client",
        importName: "HttpLink",
        uriProperty: "uri",
      },
      {
        importModule: "@apollo/client",
        importName: "createHttpLink",
        uriProperty: "uri",
      },
    ],
    ...(options.clients !== undefined
      ? { graphqlClientBindings: options.clients }
      : {}),
    ...(options.operationScopes !== undefined
      ? { graphqlOperationScopes: options.operationScopes }
      : {}),

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
      // The inputs are the `$variables` in the operation header. The
      // adapter reads them from the resolved document, so no positional
      // parameter is mapped here.
      type: "positionalParams",
      params: [],
    },
  };
}

/** What this pack reads, and what a project has to be using for it to. */
export const declares: PackDeclaration = {
  kind: "client",
  package: "@suss/client-apollo",
  dependencies: [{ ecosystem: "npm", name: "@apollo/client" }],
  reads: "\`@apollo/client\` hooks and imperative \`client.query\` calls.",
};

export default apolloClientPack;
