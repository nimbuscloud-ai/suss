// @suss/framework-apollo — PatternPack for Apollo Server (code-first).
//
// Discovers resolver functions attached to the `resolvers` property of
// an `ApolloServer` constructor-argument object. Each inner property
// becomes a `resolver`-kind BehavioralSummary whose boundary binding
// is `graphql-resolver(typeName, fieldName)`.
//
// Deferred:
//   - Schema-first shapes where resolvers are attached via
//     `addResolversToSchema` or `makeExecutableSchema` — separate
//     discovery pattern, tracked with the stub-appsync work.
//   - `mergeResolvers` / `import resolvers from "./queries"` spread
//     forms that compose resolvers across modules. v0 stops at the
//     object literal the constructor sees; multi-module composition
//     is a follow-up that needs cross-module tracking (same story as
//     the axios-wrapper expansion in the adapter).
//   - Subscription resolver shape: `Subscription.fieldName` can be
//     either a function or `{ subscribe, resolve }`. v0 discovers only
//     the function form; the `{ subscribe }` shape is opt-out via
//     `excludeTypes` today and becomes its own variant once consumer-
//     side pairing lands.

import type { PatternPack } from "@suss/extractor";

export function apolloFramework(): PatternPack {
  return {
    name: "apollo",
    languages: ["typescript", "javascript"],
    // Apollo Server runs over HTTP; GraphQL semantics are discriminated
    // at the resolver level (decision: resolver-level, not field-level)
    // and surfaced via `graphql-resolver` semantics in the binding.
    protocol: "http",

    discovery: [
      {
        kind: "resolver",
        match: {
          type: "resolverMap",
          importModule: "@apollo/server",
          importName: "ApolloServer",
          // Apollo v4 convention — the config key is `resolvers`.
          mapProperty: "resolvers",
        },
        requiresImport: ["@apollo/server"],
      },
      // Pre-v4 path: `import { ApolloServer } from "apollo-server"` /
      // `"apollo-server-express"` / similar. Same shape, different
      // module. Covers the bulk of real-world Apollo code before v4.
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
      // Resolvers return a value; errors propagate as thrown
      // exceptions (Apollo maps them to `errors[]` on the outgoing
      // response). No framework-specific response-call shape to
      // match; return + throw cover the observable behavior.
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
      // Resolvers often fall off the end without an explicit return —
      // a type resolver can delegate to the default-resolver behavior
      // by returning nothing. Keep the default transition so
      // `transitions: []` isn't the shape we ship.
      {
        kind: "return",
        match: { type: "functionFallthrough" },
        extraction: {},
      },
    ],

    // Apollo resolvers have a fixed 4-positional shape:
    //   (parent, args, context, info) => ...
    // Most resolvers ignore `parent` / `info`. We surface all four by
    // role so downstream checks can distinguish "uses args" from
    // "delegates to context" etc.
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

export default apolloFramework;
