// The provider side of a GraphQL boundary. One resolver binds one
// (typeName, fieldName) pair.

import { z } from "zod";

import { gqlIdentityKey } from "../identityKeys.js";
import { defineBoundarySemantics } from "./definition.js";

export const GraphqlResolverSemanticsSchema = z.object({
  name: z.literal("graphql-resolver"),
  /**
   * GraphQL type the resolver attaches to: "Query", "Mutation",
   * "Subscription", or an object-type name. Null when the source never
   * says which one, as with a `@Resolver()` class that has no argument.
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
  // The conventions describe the operation a client sent. They have no
  // attribute for the resolver the server ran for one field of it.
  semconv: {},
  behavior: {
    /** A resolver returns a field value, with no status. */
    exchangesHttpResponses: false,
    // A resolver runs because a client outside the process sent a query,
    // even though the server calls it in its own process.
    leavesTheProcess: true,
    reportsUnpairedItself: false,
    /**
     * `"gql:<TypeName>.<fieldName>"`, or null when the type is null or
     * the field is empty, which is how a resolver reports that the
     * source never gave them.
     */
    identityKey(semantics) {
      if (semantics.typeName === null || semantics.fieldName === "") {
        return null;
      }
      return gqlIdentityKey(semantics.typeName, semantics.fieldName);
    },
  },
});
