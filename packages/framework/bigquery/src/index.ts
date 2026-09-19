/**
 * Recognize BigQuery calls and emit `storage-access` effects.
 *
 * A caller reaches BigQuery two ways, so this declares two chains. One
 * hands over a statement written in BigQuery's SQL, either as the
 * argument or under the `query` key of an options object. The other
 * reaches a table through a chain, `bigquery.dataset(d).table(t)`, and
 * then reads or writes it without any SQL at all.
 *
 * Both record the dataset as the scope and the table as the container,
 * so an access written each way pairs with the other. A statement says
 * its dataset inside a backtick-quoted three-part name, which
 * `@suss/sql` splits; a chain says it on the way past.
 */

import { declaredBy, pack, sqlStatements, storageCalls } from "@suss/recognize";

import type { PackDeclaration } from "@suss/ir-core";
import type {
  ArgumentPick,
  CallStep,
  PatternPack,
  SqlMethod,
  StorageMethod,
} from "@suss/recognize";

/** The library a call has to come from. */
const CLIENT_MODULE = "@google-cloud/bigquery";

/** The store, in the words OpenTelemetry's semantic conventions use. */
const STORAGE_SYSTEM = "gcp.bigquery";

/** Where a job states its statement, in the two spellings the client takes. */
const STATEMENT: SqlMethod = {
  statement: [{ at: 0 }, { at: 0, property: ["query"] }],
};

const QUERIES = sqlStatements({
  system: STORAGE_SYSTEM,
  dialect: "bigquery",
  client: declaredBy(CLIENT_MODULE),
})
  .methods({
    query: STATEMENT,
    createQueryJob: STATEMENT,
    createQueryStream: STATEMENT,
  })
  .example(
    'bigquery.query("SELECT id, name FROM `analytics.core.dim_account`")',
  );

/** The calls in the chain that say what the operation is addressing. */
const DATASET_STEP: CallStep = { to: "receiver", method: "dataset" };
const TABLE_STEP: CallStep = { to: "receiver", method: "table" };

/** Which table the operation reached, and which dataset it is in. */
const TABLE: ArgumentPick = { of: [TABLE_STEP], at: 0 };
const DATASET: ArgumentPick = { of: [DATASET_STEP], at: 0 };

/** A call over the rows of a table, which touches every column there is. */
const READ_ROWS: StorageMethod = { kind: "read", fields: ["*"] };
const WRITE_ROWS: StorageMethod = { kind: "write", fields: ["*"] };

/**
 * A call about the table rather than its rows. `exists` asks whether
 * the table is there and `delete` removes it, so neither states a
 * column and the fields stay empty.
 */
const READ_TABLE: StorageMethod = { kind: "read" };
const DROP_TABLE: StorageMethod = { kind: "write" };

/** Every operation this reads off a table, and whether it reads or writes. */
const OPERATIONS: Record<string, StorageMethod> = {
  insert: WRITE_ROWS,
  load: WRITE_ROWS,
  getRows: READ_ROWS,
  exists: READ_TABLE,
  delete: DROP_TABLE,
};

const TABLE_CALLS = storageCalls({
  system: STORAGE_SYSTEM,
  client: declaredBy(CLIENT_MODULE),
})
  .methods(OPERATIONS)
  .container(TABLE)
  .scope(DATASET)
  .example('bigquery.dataset("core").table("dim_account").insert(rows)');

/**
 * Pack export. Two declarations over one wire, gated on a file reaching
 * the client library, since that is where a call can come from.
 */
export function bigqueryFramework(): PatternPack {
  return pack("bigquery", [QUERIES, TABLE_CALLS], {
    languages: ["typescript", "javascript"],
    recognizedAs: "@suss/framework-bigquery",
  });
}

/** What this pack reads, and what a project has to be using for it to. */
export const declares: PackDeclaration = {
  kind: "effects",
  package: "@suss/framework-bigquery",
  dependencies: [{ ecosystem: "npm", name: "@google-cloud/bigquery" }],
  reads:
    "BigQuery queries and table calls, emits storage-access interactions with the dataset as the scope.",
};

export default bigqueryFramework;
