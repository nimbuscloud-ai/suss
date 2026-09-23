/**
 * NestJS wires GraphQL resolvers itself, so there is no resolver map for
 * the apollo pack to find, and this pack discovers them by decorator.
 *
 * `@Query`, `@Mutation` and `@Subscription` put their field on the root
 * type whatever the class decorator says. `@Resolver(() => User)` gives
 * the type only for `@ResolveField`. The README walks through that rule
 * and lists what the pack does not read yet.
 */
import { z } from "zod";

import type { PatternPack } from "@suss/extractor";
import type { PackDeclaration } from "@suss/ir-core";

/**
 * The CLI checks a `-f nestjs-graphql=config.json` file against this
 * schema. A config file may not set a key that only a dependency stub
 * fills.
 */
export const optionsSchema = z
  .object({
    /**
     * Class decorators that wrap `@Resolver()` in a package outside the
     * project. A dependency stub fills this. A wrapper written in the
     * project needs no entry, because the adapter reads its body and
     * sees it call `Resolver` from `@nestjs/graphql`.
     */
    classDecorators: z.array(z.string()).optional(),
  })
  .strict();

export type NestjsGraphqlPackOptions = z.infer<typeof optionsSchema>;

export function nestjsGraphqlFramework(
  options: NestjsGraphqlPackOptions = {},
): PatternPack {
  return {
    name: "nestjs-graphql",
    languages: ["typescript"],
    // Apollo Server runs underneath `GraphQLModule.forRoot`, so the
    // transport is HTTP here as it is for the apollo pack.
    protocol: "http",

    discovery: [
      {
        kind: "resolver",
        match: {
          type: "decoratedMethod",
          importModule: "@nestjs/graphql",
          // The first match wins, so the framework's own decorator is
          // tried before any wrapper.
          classDecorators: ["Resolver", ...(options.classDecorators ?? [])],
          methodDecorators: [
            "Query",
            "Mutation",
            "ResolveField",
            "Subscription",
          ],
          // `ResolveField` is left out because its type comes from the
          // class decorator.
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
      // A resolver has no response call. It returns a value or throws,
      // and NestJS turns a thrown exception into `errors[]`.
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
        // A resolver for an optional field can fall off the end. Without
        // this terminal that unit would come out with no transitions.
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

export const declares: PackDeclaration = {
  kind: "framework",
  package: "@suss/framework-nestjs-graphql",
  dependencies: [{ ecosystem: "npm", name: "@nestjs/graphql" }],
  reads: "NestJS GraphQL resolvers.",
};

export default nestjsGraphqlFramework;
