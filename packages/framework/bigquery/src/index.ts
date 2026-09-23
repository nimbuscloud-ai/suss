/**
 * Recognizes BigQuery calls and records each one as a storage access.
 * A caller either hands over a SQL statement or reaches a table through
 * `bigquery.dataset(d).table(t)` and calls a method on it, so the pack
 * declares one chain for each.
 *
 * Both record the dataset as the scope and the table as the container, so
 * an access written one way pairs with the same access written the other
 * way. `@suss/sql` splits the dataset out of a statement's backtick-quoted
 * three-part name.
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

const CLIENT_MODULE = "@google-cloud/bigquery";

/** Spelled the way OpenTelemetry's semantic conventions write it. */
const STORAGE_SYSTEM = "gcp.bigquery";

/** The client takes the statement as the argument or under `query`. */
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

const DATASET_STEP: CallStep = { to: "receiver", method: "dataset" };
const TABLE_STEP: CallStep = { to: "receiver", method: "table" };

const TABLE: ArgumentPick = { of: [TABLE_STEP], at: 0 };
const DATASET: ArgumentPick = { of: [DATASET_STEP], at: 0 };

/** These calls move whole rows, so they touch every column. */
const READ_ROWS: StorageMethod = { kind: "read", fields: ["*"] };
const WRITE_ROWS: StorageMethod = { kind: "write", fields: ["*"] };

/** `exists` and `delete` act on the table itself and touch no column. */
const READ_TABLE: StorageMethod = { kind: "read" };
const DROP_TABLE: StorageMethod = { kind: "write" };

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
 * A call counts only when its client is declared by
 * `@google-cloud/bigquery`, so a look-alike `query` method elsewhere is
 * ignored.
 */
export function bigqueryFramework(): PatternPack {
  return pack("bigquery", [QUERIES, TABLE_CALLS], {
    languages: ["typescript", "javascript"],
    recognizedAs: "@suss/framework-bigquery",
  });
}

export const declares: PackDeclaration = {
  kind: "effects",
  package: "@suss/framework-bigquery",
  dependencies: [{ ecosystem: "npm", name: "@google-cloud/bigquery" }],
  reads:
    "BigQuery queries and table calls. Each one becomes a storage-access interaction scoped to its dataset.",
};

export default bigqueryFramework;
