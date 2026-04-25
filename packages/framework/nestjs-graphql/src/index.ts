// @suss/framework-nestjs-graphql — PatternPack for NestJS GraphQL
// resolvers (`@nestjs/graphql`).
//
// NestJS expresses resolvers as classes decorated with `@Resolver()`,
// where each method carries a GraphQL operation decorator
// (`@Query` / `@Mutation` / `@ResolveField` / `@Subscription`).
// There is no `new ApolloServer({ resolvers: {...} })` call in user
// code — the framework wires resolvers internally — so the
// resolverMap-style discovery used by `@suss/framework-apollo` finds
// nothing here. Decorator-driven discovery covers it.
//
// Resolver typeName comes from the class decorator's first argument
// (`@Resolver(() => User)` → "User"). Class decorators with no
// argument fall back to the operation kind ("Query" / "Mutation" /
// "Subscription") so top-level operation classes still produce
// well-formed `graphql-resolver` bindings.
//
// Field name reads the method-decorator's `name` option override
// (`@Query(() => User, { name: "lookupUser" })`) when present;
// otherwise the method's own name.
//
// Inputs are mapped by parameter decorator. NestJS uses
// `@Args()` / `@Parent()` / `@Context()` / `@Info()` to inject the
// (parent, args, context, info) tuple Apollo passes positionally.
// Each parameter's first matching decorator names its role.
//
// Deferred:
//   - `@Args('field')` shape: today every `@Args` lands as a single
//     "args" Input; v0 doesn't decompose the field-path / type
//     options. Adequate for the binding identity; pairing logic that
//     wants per-arg shape will need a richer decorator-arg parse.
//   - Class inheritance / mixins: resolvers split across an abstract
//     base + concrete child are discovered separately but pairing
//     doesn't yet collapse them.
//   - Decorator factories (`createParamDecorator(...)`-defined custom
//     decorators) bypass the role map.

import type { PatternPack } from "@suss/extractor";

export function nestjsGraphqlFramework(): PatternPack {
  return {
    name: "nestjs-graphql",
    languages: ["typescript"],
    // Apollo Server runs underneath via `GraphQLModule.forRoot({...
    // ApolloDriver })`; the wire transport stays HTTP regardless of
    // whether the resolver was discovered via decorator or via an
    // object-literal resolver map.
    protocol: "http",

    discovery: [
      {
        kind: "resolver",
        match: {
          type: "decoratedMethod",
          importModule: "@nestjs/graphql",
          // First-match-wins. Bare `@Resolver()` is the canonical
          // NestJS shape; the `*Resolver` aliases cover the dominant
          // wrapper convention seen in NestJS codebases that compose
          // the bare decorator with project-specific metadata.
          classDecorators: [
            "Resolver",
            "MetadataResolver",
            "CoreResolver",
            "AdminResolver",
          ],
          methodDecorators: [
            "Query",
            "Mutation",
            "ResolveField",
            "Subscription",
          ],
        },
        requiresImport: ["@nestjs/graphql"],
      },
    ],

    terminals: [
      // Resolvers return a value; errors propagate as thrown
      // exceptions (NestJS / Apollo map them to `errors[]` on the
      // outgoing response). No framework-specific response-call
      // shape — return + throw cover the observable behaviour.
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
      {
        // Resolver methods can fall through (return `undefined`) when
        // the field is optional and the parent already carries the
        // value. Keep a default transition so `transitions: []` isn't
        // the surface shape.
        kind: "return",
        match: { type: "functionFallthrough" },
        extraction: {},
      },
    ],

    inputMapping: {
      type: "decoratedParams",
      decoratorRoleMap: {
        Args: "args",
        Parent: "parent",
        Context: "context",
        Info: "info",
      },
    },
  };
}

export default nestjsGraphqlFramework;
