/**
 * The consumer side of a GraphQL boundary.
 *
 * A document a client sends to a server, identified by its operation
 * name and type. A dedicated pass pairs operations, and the generic
 * keyed pairing never sees them, so this protocol has no identity key.
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
  semconv: {
    operationName: { name: "graphql.operation.name" },
    operationType: { name: "graphql.operation.type" },
  },
  behavior: {
    /**
     * An operation gets a data-and-errors document back, which the
     * GraphQL contract checker reads. Status codes do not apply.
     */
    exchangesHttpResponses: false,
    leavesTheProcess: true,
    reportsUnpairedItself: false,
    identityKey: () => null,
    /** No key on purpose. The dedicated pass pairs an operation by its document. */
    canPair: () => true,
    /** `query GetUser`. Only for display, since the contract checker does the pairing. */
    displayLabel(semantics) {
      return `${semantics.operationType} ${semantics.operationName ?? "<anonymous>"}`;
    },
  },
});
