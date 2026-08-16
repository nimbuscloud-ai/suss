/**
 * A relational storage table as a boundary.
 *
 * The columns are fields on the table's contract. Storage is paired by
 * its own dedicated pass, so this protocol has no identity key.
 */

import { z } from "zod";

import { defineBoundarySemantics } from "./definition.js";

export const StorageRelationalSemanticsSchema = z.object({
  name: z.literal("storage-relational"),
  storageSystem: z.enum(["postgres", "mysql", "sqlite"]),
  /**
   * The ORM or driver scope. A single-database setup uses `"default"`,
   * and a monorepo with several schemas gives each one its own value.
   */
  scope: z.string(),
  /**
   * The table or model name as the schema declares it, or null when
   * the source states one this reader could not settle. A null table
   * pairs with nothing, rather than with whatever its source text
   * happens to spell.
   */
  table: z.string().nullable(),
});

export type StorageRelationalSemantics = z.infer<
  typeof StorageRelationalSemanticsSchema
>;

export const storageRelationalSemantics = defineBoundarySemantics({
  name: "storage-relational",
  schema: StorageRelationalSemanticsSchema,
  behavior: {
    /** A query returns rows, not a status and a body. */
    exchangesHttpResponses: false,
    reportsUnpairedItself: false,
    identityKey: () => null,
  },
});
