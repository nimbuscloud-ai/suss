// graphqlResolver.ts: the provider side of a GraphQL boundary.
//
// One resolver binds one (typeName, fieldName) pair.

import { z } from "zod";

import { defineBoundarySemantics } from "./definition.js";

export const GraphqlResolverSemanticsSchema = z.object({
  name: z.literal("graphql-resolver"),
  /**
   * GraphQL type the resolver attaches to: "Query", "Mutation",
   * "Subscription", or an object-type name. Null when the source
   * never names one (a `@Resolver()` class with no argument).
   */
  typeName: z.string().min(1).nullable(),
  /** Field name on that type. */
  fieldName: z.string(),
});

export type GraphqlResolverSemantics = z.infer<
  typeof GraphqlResolverSemanticsSchema
>;

export const graphqlResolverSemantics = defineBoundarySemantics({
  name: "graphql-resolver",
  schema: GraphqlResolverSemanticsSchema,
  behavior: {
    /** A resolver returns a field value, not a status and a body. */
    exchangesHttpResponses: false,
    reportsUnpairedItself: false,
    /**
     * `"gql:<TypeName>.<fieldName>"`; null when the type is null or
     * the field empty, which is how a resolver says the source never
     * named them.
     */
    identityKey(semantics) {
      if (semantics.typeName === null || semantics.fieldName === "") {
        return null;
      }
      return `gql:${semantics.typeName}.${semantics.fieldName}`;
    },
  },
});
