/**
 * A store as a boundary: a SQL table, a DynamoDB table, a bucket, a
 * collection, an index.
 *
 * The fields here are the ones both sides can spell. A schema reader
 * knows the container it declares and a call site knows the container
 * it addresses, so those are what the pairing pass keys on. What only
 * the schema knows, whether its field list is the complete set, goes on
 * the provider's `storageContract` metadata instead.
 *
 * One variant covers every family because the families differ by
 * declared properties rather than by name. Storage is paired by its own
 * dedicated pass, so this protocol has no identity key.
 */

import { z } from "zod";

import { defineBoundarySemantics } from "./definition.js";

export const StorageSemanticsSchema = z.object({
  name: z.literal("storage"),
  /**
   * Which store this is: postgresql, mysql, aws.dynamodb, or our own
   * word for one OpenTelemetry never named, such as s3. Two products'
   * containers can share a name, so this keeps them apart.
   */
  storageSystem: z.string(),
  /**
   * The ORM, schema, or deployment scope. A single-database setup uses
   * `"default"`, and a monorepo with several schemas gives each one its
   * own value.
   */
  scope: z.string(),
  /**
   * The table, bucket, collection, or index, as the source declares
   * it, or null when the source states one this reader could not
   * settle. A null container pairs with nothing, rather than with
   * whatever its source text happens to spell. The string is in the
   * boundary-name syntax: a literal, a pattern with `{}` holes, or a
   * reference, and `parseBoundaryName` is the one reader of it.
   */
  container: z.string().nullable(),
  /**
   * A secondary way into the container, a DynamoDB global secondary
   * index or an Elasticsearch alias, each with its own key fields.
   * Null means the container's own primary way in. A query through an
   * index and a query through the table are different accesses, so
   * they pair separately.
   */
  accessPath: z.string().nullable(),
});

export type StorageSemantics = z.infer<typeof StorageSemanticsSchema>;

export const storageSemantics = defineBoundarySemantics({
  name: "storage",
  schema: StorageSemanticsSchema,
  semconv: {
    storageSystem: { name: "db.system.name" },
    // "default" is our word for a source that named no database.
    scope: { name: "db.namespace", placeholderValues: ["default"] },
    container: { name: "db.collection.name" },
    // A secondary index has no attribute of its own, so accessPath
    // stays our word.
  },
  behavior: {
    /** A query returns rows or items, not a status and a body. */
    exchangesHttpResponses: false,
    reportsUnpairedItself: false,
    identityKey: () => null,
  },
});
