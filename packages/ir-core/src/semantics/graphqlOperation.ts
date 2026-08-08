/**
 * The consumer side of a GraphQL boundary.
 *
 * A document sent from a client to a server, identified by its
 * operation name and type. Operations are paired by their own dedicated
 * pass rather than by the generic keyed pairing, so this protocol has no
 * identity key at all.
 */

import { z } from "zod";

import { defineBoundarySemantics } from "./definition.js";

export const GraphqlOperationSemanticsSchema = z.object({
  name: z.literal("graphql-operation"),
  /** Optional operation name. An anonymous query or mutation leaves it unset. */
  operationName: z.string().optional(),
  operationType: z.enum(["query", "mutation", "subscription"]),
});

export type GraphqlOperationSemantics = z.infer<
  typeof GraphqlOperationSemanticsSchema
>;

export const graphqlOperationSemantics = defineBoundarySemantics({
  name: "graphql-operation",
  schema: GraphqlOperationSemanticsSchema,
  behavior: {
    /**
     * An operation gets a data-and-errors document back, which the
     * GraphQL contract checker reads. Status codes say nothing here.
     */
    exchangesHttpResponses: false,
    reportsUnpairedItself: false,
    identityKey: () => null,
    /** "query GetUser". The contract checker pairs it, the key does not. */
    displayLabel(semantics) {
      return `${semantics.operationType} ${semantics.operationName ?? "<anonymous>"}`;
    },
  },
});
