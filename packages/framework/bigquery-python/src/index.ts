/**
 * The calls a Python body makes against BigQuery, through the
 * `google-cloud-bigquery` client or the Airflow Google provider's hook.
 * The adapter reads each statement through the value evaluator and
 * `@suss/sql` finds the tables in it. The README lists what each method
 * is read as and what the pack leaves out.
 */

import type { PythonPack, SqlClientPattern } from "@suss/adapter-python";
import type { PackDeclaration } from "@suss/ir-core";

/** Spelled the way OpenTelemetry writes its `db.system` values. */
const STORAGE_SYSTEM = "gcp.bigquery";

/** `@suss/sql` looks the dialect up by this name. */
const DIALECT = "bigquery";

const CLIENT_MODULE = "google.cloud.bigquery";

const HOOK_MODULE = "airflow.providers.google.cloud.hooks.bigquery";

const CLIENT_STATEMENTS = [
  { method: "query", argument: 0, keyword: "query" },
  { method: "query_and_wait", argument: 0, keyword: "query" },
];

/**
 * Calls that take a table name instead of SQL. The loaders take the table
 * second, after the rows they load.
 */
const CLIENT_TABLES = [
  { method: "get_table", argument: 0, keyword: "table", kind: "read" as const },
  { method: "list_rows", argument: 0, keyword: "table", kind: "read" as const },
  {
    method: "insert_rows",
    argument: 0,
    keyword: "table",
    kind: "write" as const,
  },
  {
    method: "insert_rows_json",
    argument: 0,
    keyword: "table",
    kind: "write" as const,
  },
  {
    method: "delete_table",
    argument: 0,
    keyword: "table",
    kind: "write" as const,
  },
  {
    method: "load_table_from_dataframe",
    argument: 1,
    keyword: "destination",
    kind: "write" as const,
  },
  {
    method: "load_table_from_json",
    argument: 1,
    keyword: "destination",
    kind: "write" as const,
  },
  {
    method: "load_table_from_uri",
    argument: 1,
    keyword: "destination",
    kind: "write" as const,
  },
  {
    method: "load_table_from_file",
    argument: 1,
    keyword: "destination",
    kind: "write" as const,
  },
];

/**
 * `insert_job` takes a whole job configuration, with the statement two
 * keys down. `run_query` is the older spelling of the same call.
 */
const HOOK_STATEMENTS = [
  { method: "get_records", argument: 0, keyword: "sql" },
  { method: "get_first", argument: 0, keyword: "sql" },
  { method: "get_pandas_df", argument: 0, keyword: "sql" },
  { method: "run_query", argument: 0, keyword: "sql" },
  {
    method: "insert_job",
    argument: 0,
    keyword: "configuration",
    path: ["query", "query"],
  },
];

const HOOK_TABLES = [
  {
    method: "delete_table",
    argument: 0,
    keyword: "table_id",
    kind: "write" as const,
  },
];

/**
 * The BigQuery client and the Airflow hook, with the calls on each that
 * take a statement or a table. Only the libraries' own names go here.
 */
export function bigqueryClients(): SqlClientPattern[] {
  return [
    {
      module: CLIENT_MODULE,
      clientTypes: ["Client"],
      statements: CLIENT_STATEMENTS,
      tables: CLIENT_TABLES,
      storageSystem: STORAGE_SYSTEM,
      dialect: DIALECT,
    },
    {
      module: HOOK_MODULE,
      clientTypes: ["BigQueryHook"],
      statements: HOOK_STATEMENTS,
      tables: HOOK_TABLES,
      // The hook documents `get_client` as returning the client library's
      // own `Client`, so a chain off it is read the same way.
      handsBack: [
        { method: "get_client", module: CLIENT_MODULE, name: "Client" },
      ],
      storageSystem: STORAGE_SYSTEM,
      dialect: DIALECT,
    },
  ];
}

/**
 * Adds the BigQuery patterns to the route pack a run already uses. A
 * project picks its web framework and its warehouse client separately,
 * so the two packs combine.
 */
export function withBigquery(pack: PythonPack): PythonPack {
  return {
    ...pack,
    sqlClients: [...(pack.sqlClients ?? []), ...bigqueryClients()],
  };
}

export function bigqueryFramework(): PythonPack {
  return {
    name: "bigquery-python",
    protocol: STORAGE_SYSTEM,
    discovery: [],
    sqlClients: bigqueryClients(),
  };
}

export const declares: PackDeclaration = {
  kind: "effects",
  package: "@suss/framework-bigquery-python",
  dependencies: [
    { ecosystem: "pypi", name: "google-cloud-bigquery" },
    { ecosystem: "pypi", name: "apache-airflow-providers-google" },
  ],
  reads:
    "BigQuery calls (Python). The statement a client or an Airflow hook is handed is read for the tables it touches. Calls such as \`get_table\` and \`insert_rows\` take a table name instead of SQL, and that name is read too.",
};

export default bigqueryFramework;
