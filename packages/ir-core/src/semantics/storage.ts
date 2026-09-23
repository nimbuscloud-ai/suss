/**
 * A store as a boundary: a SQL table, a DynamoDB table, a bucket, an
 * index.
 *
 * The fields are the ones both sides can write. A schema reader knows
 * the container it declares and a call site knows the container it
 * addresses, so the pairing pass keys on those. Only the schema knows
 * whether its field list is complete, so that goes in the provider's
 * `storageContract` metadata.
 *
 * One variant covers every family, because the families differ by
 * declared properties and not by name. A dedicated pass pairs storage,
 * so this protocol has no identity key.
 */

import { z } from "zod";

import { referenceFromName } from "../boundaryName.js";
import { defineBoundarySemantics } from "./definition.js";

import type { Reference } from "../boundaryName.js";

export const StorageSemanticsSchema = z.object({
  name: z.literal("storage"),
  /**
   * The storage system: an OpenTelemetry value such as `postgresql` or
   * `aws.dynamodb`, or suss's own word for one the conventions do not
   * cover, such as `s3`. Null when the reader could not work out which
   * system the source uses. Two products' containers can share a name,
   * and this field keeps them apart. The pairing pass decides how to
   * treat a null.
   */
  storageSystem: z.string().nullable(),
  /**
   * The ORM, schema, or deployment scope. A single-database setup uses
   * `"default"`, and a monorepo with several schemas gives each one its
   * own value.
   */
  scope: z.string(),
  /**
   * The table, bucket, collection or index, as the source declares it.
   * Null when the reader could not work out the container, and a null
   * container pairs with nothing, so it cannot match by accident of
   * shared source text. The string uses the boundary-name syntax (a
   * literal, a pattern with `{}` holes, or a reference), and only
   * `parseBoundaryName` should read it.
   */
  container: z.string().nullable(),
  /**
   * A secondary way into the container, such as a DynamoDB global
   * secondary index or an Elasticsearch alias, each with its own key
   * fields. Null means the container's primary key. A query through an
   * index and a query through the table are different accesses, so
   * they pair separately.
   */
  accessPath: z.string().nullable(),
});

export type StorageSemantics = z.infer<typeof StorageSemanticsSchema>;

/** The reference for a container the source gives only as a variable. */
function containerReference(semantics: StorageSemantics): Reference | null {
  return semantics.container === null
    ? null
    : referenceFromName(semantics.container);
}

export const storageSemantics = defineBoundarySemantics({
  name: "storage",
  schema: StorageSemanticsSchema,
  semconv: {
    storageSystem: { name: "db.system.name" },
    // suss writes "default" when the source did not say which database.
    scope: { name: "db.namespace", placeholderValues: ["default"] },
    container: { name: "db.collection.name" },
    // The conventions have no attribute for a secondary index, so
    // accessPath is left out.
  },
  behavior: {
    /** A query returns rows or items, with no status. */
    exchangesHttpResponses: false,
    leavesTheProcess: true,
    reportsUnpairedItself: false,
    identityKey: () => null,
    displayLabel: storageLabel,
    /**
     * A container the source gives as a variable is whatever the
     * deployment sets that variable to. `{SUBSCRIBERS_TABLE}` in the
     * code and `prod-subscribers-v1` in the manifest are one table.
     */
    groundName(semantics, deployment) {
      const reference = containerReference(semantics);
      if (reference === null) {
        return null;
      }
      const name = deployment.setTo(reference);
      return name === null ? null : { ...semantics, container: name };
    },
    nameReference: containerReference,
  },
});

/**
 * The store's label, such as `postgresql:invoices` or
 * `aws.dynamodb:editions#by-publication`. Storage has no identity key,
 * so `suss ask`, the pass that indexes accesses, and an intent doc all
 * refer to a store by this label.
 */
export function storageLabel(semantics: StorageSemantics): string {
  return `${storageSystemLabel(semantics)}:${storageContainerLabel(semantics)}`;
}

/** The storage system, or `<unknown engine>` when it is null. */
export function storageSystemLabel(semantics: StorageSemantics): string {
  return semantics.storageSystem ?? UNKNOWN_ENGINE;
}

const UNKNOWN_ENGINE = "<unknown engine>";

/**
 * The column list an access records when it reads every column, as a
 * query without an explicit projection does. It means all columns and
 * does not list any, so code comparing column lists has to handle it
 * separately.
 */
export const EVERY_FIELD = "*";

/** The store's label without the storage system, as a finding writes it. */
export function storageContainerLabel(semantics: StorageSemantics): string {
  const container = semantics.container ?? "<unnamed container>";
  // An access path is written after its container, since a query through
  // an index is a different access.
  const addressed =
    semantics.accessPath === null
      ? container
      : `${container}#${semantics.accessPath}`;
  // A store in the default scope is written as the bare container. Any
  // other scope is kept as a prefix, since it tells two stores apart.
  return semantics.scope === "default"
    ? addressed
    : `${semantics.scope}/${addressed}`;
}
