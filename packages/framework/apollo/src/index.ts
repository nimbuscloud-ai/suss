/**
 * Each property of the `resolvers` map passed to `ApolloServer` becomes a
 * resolver unit. The README lists the resolver wiring the pack does not
 * read yet, such as schema-first setups and `mergeResolvers(...)`.
 */

import type { PatternPack } from "@suss/extractor";
import type { PackDeclaration } from "@suss/ir-core";

export function apolloFramework(): PatternPack {
  return {
    name: "apollo",
    languages: ["typescript", "javascript"],
    // Apollo Server runs over HTTP. The GraphQL type and field are set
    // per resolver, on the `graphql-resolver` binding.
    protocol: "http",

    discovery: [
      {
        kind: "resolver",
        match: {
          type: "resolverMap",
          importModule: "@apollo/server",
          importName: "ApolloServer",
          mapProperty: "resolvers",
        },
        requiresImport: ["@apollo/server"],
      },
      // Apollo before v4 exported the same `ApolloServer` from
      // `apollo-server` and `apollo-server-express`.
      {
        kind: "resolver",
        match: {
          type: "resolverMap",
          importModule: "apollo-server",
          importName: "ApolloServer",
          mapProperty: "resolvers",
        },
        requiresImport: ["apollo-server"],
      },
      {
        kind: "resolver",
        match: {
          type: "resolverMap",
          importModule: "apollo-server-express",
          importName: "ApolloServer",
          mapProperty: "resolvers",
        },
        requiresImport: ["apollo-server-express"],
      },
    ],

    terminals: [
      // A resolver has no response call. It returns a value or throws,
      // and Apollo turns a thrown error into `errors[]`.
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
      // A resolver that returns nothing hands off to Apollo's default
      // resolver. Without this terminal it would come out with no
      // transitions.
      {
        kind: "return",
        match: { type: "functionFallthrough" },
        extraction: {},
      },
    ],

    // All four positions get a role, even though most resolvers ignore
    // `parent` and `info`, so a check can tell a resolver that reads
    // `args` from one that hands off to `context`.
    inputMapping: {
      type: "positionalParams",
      params: [
        { position: 0, role: "parent" },
        { position: 1, role: "args" },
        { position: 2, role: "context" },
        { position: 3, role: "info" },
      ],
    },
  };
}

export const declares: PackDeclaration = {
  kind: "framework",
  package: "@suss/framework-apollo",
  dependencies: [{ ecosystem: "npm", name: "@apollo/server" }],
  reads: "Apollo Server resolvers (code-first).",
};

export default apolloFramework;
