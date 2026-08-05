// graphqlOperation.ts: the consumer side of a GraphQL boundary.
//
// A document sent from client to server, bound by operation name and
// type. Operations pair through their own dedicated pass rather than
// through the generic keyed pairing, so this protocol has no identity
// key.

import { z } from "zod";

import { defineBoundarySemantics } from "./definition.js";

export const GraphqlOperationSemanticsSchema = z.object({
  name: z.literal("graphql-operation"),
  /** Optional operation name — anonymous queries / mutations leave this unset. */
  operationName: z.string().optional(),
  operationType: z.enum(["query", "mutation", "subscription"]),
});

export type GraphqlOperationSemantics = z.infer<
  typeof GraphqlOperationSemanticsSchema
>;

export const graphqlOperationSemantics = defineBoundarySemantics({
  name: "graphql-operation",
  schema: GraphqlOperationSemanticsSchema,
  behavior: { identityKey: () => null },
});
