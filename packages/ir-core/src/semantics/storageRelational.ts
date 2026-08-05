// storageRelational.ts: a relational storage table as a boundary.
//
// Columns are FIELDS on the table's contract. Storage pairs through
// its own dedicated pass, so this protocol has no identity key.

import { z } from "zod";

import { defineBoundarySemantics } from "./definition.js";

export const StorageRelationalSemanticsSchema = z.object({
  name: z.literal("storage-relational"),
  storageSystem: z.enum(["postgres", "mysql", "sqlite"]),
  /**
   * ORM / driver scope. Defaults to `"default"` for single-database
   * setups; monorepos with multiple schemas use distinct values.
   */
  scope: z.string(),
  /** Table / model name as declared in the schema. */
  table: z.string(),
});

export type StorageRelationalSemantics = z.infer<
  typeof StorageRelationalSemanticsSchema
>;

export const storageRelationalSemantics = defineBoundarySemantics({
  name: "storage-relational",
  schema: StorageRelationalSemanticsSchema,
  behavior: { identityKey: () => null },
});
