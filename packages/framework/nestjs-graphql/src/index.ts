// @suss/framework-nestjs-graphql: the PatternPack for NestJS GraphQL
// resolvers (`@nestjs/graphql`).
//
// NestJS expresses resolvers as classes decorated with `@Resolver()`,
// where each method has a GraphQL operation decorator on it
// (`@Query`, `@Mutation`, `@ResolveField`, or `@Subscription`).
// There is no `new ApolloServer({ resolvers: {...} })` call in user
// code, because the framework wires resolvers internally, so the
// resolverMap-style discovery used by `@suss/framework-apollo` finds
// nothing here. Decorator-driven discovery covers it.
//
// Resolver typeName comes from the class decorator's first argument
// (`@Resolver(() => User)` → "User"). A class decorator with no
// argument leaves it to the operation decorator: `@Query` puts its
// field on the root `Query` type and `@Mutation` on `Mutation`, so a
// top-level operation class still produces a well-formed
// `graphql-resolver` binding.
//
// `@ResolveField` is the one that cannot say this for itself. The type it
// resolves a field on is what the class decorator's argument would have given,
// so on a class that passes no argument there is nothing left to read it from.
// The binding then has no type, the summary gets a gap saying so, and nothing
// pairs with it. NestJS rejects that class at
// startup; suss reports what it could not read rather than picking a
// root operation type and claiming a field the schema does not have.
//
// Field name reads the method-decorator's `name` option override
// (`@Query(() => User, { name: "lookupUser" })`) when present;
// otherwise the method's own name.
//
// Inputs are mapped by parameter decorator. NestJS uses
// `@Args()` / `@Parent()` / `@Context()` / `@Info()` to inject the
// (parent, args, context, info) tuple Apollo passes positionally.
// Each parameter's first matching decorator decides its role.
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

export interface NestjsGraphqlPackOptions {
  /**
   * Class decorators this project composes `@Resolver()` into, for the
   * cases the adapter cannot follow on its own.
   *
   * A wrapper written in the project needs no entry here: the adapter
   * resolves a class decorator to the function behind it and accepts it
   * when calling that function calls `Resolver` from
   * `@nestjs/graphql`. What is left for this option is a wrapper whose
   * body is not in the project, so there is nothing to read.
   */
  classDecorators?: string[];
}

export function nestjsGraphqlFramework(
  options: NestjsGraphqlPackOptions = {},
): PatternPack {
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
          // First match wins, so the framework's own decorator is
          // tried before any wrapper a project names.
          classDecorators: ["Resolver", ...(options.classDecorators ?? [])],
          methodDecorators: [
            "Query",
            "Mutation",
            "ResolveField",
            "Subscription",
          ],
          // The three NestJS routes to a root operation type, each
          // named after the type it puts its field on. `ResolveField`
          // is deliberately absent: it needs the class to name a type.
          methodDecoratorTypeMap: {
            Query: "Query",
            Mutation: "Mutation",
            Subscription: "Subscription",
          },
        },
        requiresImport: ["@nestjs/graphql"],
      },
    ],

    terminals: [
      // Resolvers return a value; errors propagate as thrown
      // exceptions (NestJS / Apollo map them to `errors[]` on the
      // outgoing response). No framework-specific response-call
      // shape: return + throw cover the observable behaviour.
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
        // Resolver methods can fall through and return `undefined` when the
        // field is optional and the parent object already has the value. Keep a
        // default transition so the unit does not come out with no transitions
        // at all.
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
