/**
 * A key-value or document table as a boundary.
 *
 * Separate from storage-relational because the relational variant's
 * own fields do not describe one: `storageSystem` is a closed list of
 * SQL engines, and `scope` means an ORM schema, which DynamoDB has no
 * counterpart for. Widening that variant would make its own
 * description false and every relational pass would need a carve-out.
 *
 * Paired by table name through the storage pass, the way the
 * relational variant is, so this protocol has no identity key.
 */

import { z } from "zod";

import { defineBoundarySemantics } from "./definition.js";

export const StorageTableSemanticsSchema = z.object({
  name: z.literal("storage-table"),
  storageSystem: z.literal("dynamodb"),
  /**
   * The table's own name, which is what code addresses it by. Null
   * when the template computes it, so it pairs with nothing rather
   * than with whatever the expression happens to spell.
   */
  table: z.string().nullable(),
});

export type StorageTableSemantics = z.infer<typeof StorageTableSemanticsSchema>;

export const storageTableSemantics = defineBoundarySemantics({
  name: "storage-table",
  schema: StorageTableSemanticsSchema,
  behavior: {
    /** A query returns items, not a status and a body. */
    exchangesHttpResponses: false,
    reportsUnpairedItself: false,
    identityKey: () => null,
    /** The storage pass pairs by table name, so a keyless table still pairs. */
    canPair: (semantics) => semantics.table !== null,
    displayLabel(semantics) {
      return semantics.table === null
        ? "dynamodb table"
        : `dynamodb ${semantics.table}`;
    },
  },
});
