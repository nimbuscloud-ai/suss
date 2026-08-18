/**
 * The PatternPack for NestJS GraphQL resolvers (`@nestjs/graphql`).
 *
 * NestJS expresses resolvers as classes decorated with `@Resolver()`,
 * where each method has a GraphQL operation decorator on it. The
 * framework wires them internally, so there is no
 * `new ApolloServer({ resolvers: {...} })` call for the resolver-map
 * discovery in `@suss/framework-apollo` to find.
 *
 * Which type owns a field is the part that is easy to get backwards:
 * `@Query` and `@Mutation` settle it themselves, and
 * `@Resolver(() => User)` is there for `@ResolveField`. The README
 * beside this file spells that out, along with what v0 leaves out.
 */
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
          // The three that settle their own type, each named after the
          // type it puts its field on. `ResolveField` is deliberately
          // absent: it is the one that needs the class decorator.
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
