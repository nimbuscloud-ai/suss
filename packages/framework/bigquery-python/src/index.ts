/**
 * @suss/framework-bigquery-python: which calls a Python body makes
 * against BigQuery.
 *
 * Two libraries reach the same warehouse. `google-cloud-bigquery` hands
 * a project a `Client`, and the Google provider for Airflow hands it a
 * `BigQueryHook` that wraps one. Both take the statement the project
 * wrote, so the adapter reads it through the value evaluator and the
 * SQL reader says which table it touches. The README says what each
 * method is read as and what this leaves out.
 */

import type { PythonPack, SqlClientPattern } from "@suss/adapter-python";
import type { PackDeclaration } from "@suss/ir-core";

/** BigQuery's name in the style of OpenTelemetry's `db.system` values. */
const STORAGE_SYSTEM = "gcp.bigquery";

/** The dialect BigQuery statements are written in, which `@suss/sql` reads under that name. */
const DIALECT = "bigquery";

/** The module the client library exports its client from. */
const CLIENT_MODULE = "google.cloud.bigquery";

/** The module the Airflow provider exports its hook from. */
const HOOK_MODULE = "airflow.providers.google.cloud.hooks.bigquery";

/**
 * The client's own calls that take a statement. Each takes it first
 * positionally and also under the keyword the library gives it.
 */
const CLIENT_STATEMENTS = [
  { method: "query", argument: 0, keyword: "query" },
  { method: "query_and_wait", argument: 0, keyword: "query" },
];

/**
 * The client's calls that say which table rather than writing SQL. The
 * loaders take the table second, after the rows they are loading.
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
 * The hook's calls that take a statement. `insert_job` takes a whole job
 * configuration, and the statement is two keys inside it. `run_query` is
 * the older spelling of the same thing.
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

/** The hook's calls that say which table. It spells the argument `table_id`. */
const HOOK_TABLES = [
  {
    method: "delete_table",
    argument: 0,
    keyword: "table_id",
    kind: "write" as const,
  },
];

/**
 * What the two libraries hand a project, and what a call on one means.
 * Everything here is the libraries' own: the modules, the class names,
 * the method names, and where each method takes what it is given.
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
      // The hook documents `get_client` as handing back the client
      // library's own `Client`, so a chain off it reads as one.
      handsBack: [
        { method: "get_client", module: CLIENT_MODULE, name: "Client" },
      ],
      storageSystem: STORAGE_SYSTEM,
      dialect: DIALECT,
    },
  ];
}

/**
 * Add the BigQuery patterns to the route pack a run already uses. A web
 * framework and a warehouse client are separate libraries and a project
 * picks both, so this composes rather than replacing anything.
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

/** What this pack reads, and what a project has to be using for it to. */
export const declares: PackDeclaration = {
  kind: "effects",
  package: "@suss/framework-bigquery-python",
  dependencies: [
    { ecosystem: "pypi", name: "google-cloud-bigquery" },
    { ecosystem: "pypi", name: "apache-airflow-providers-google" },
  ],
  reads:
    "BigQuery calls (Python): the statement a client or an Airflow hook is handed, read for the tables it touches, and the calls that say which table without writing SQL.",
};

export default bigqueryFramework;
