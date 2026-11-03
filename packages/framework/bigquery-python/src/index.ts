/**
 * The calls a Python body makes against BigQuery, through the
 * `google-cloud-bigquery` client or the Airflow Google provider's hook.
 * A statement is read for the tables it touches, and a call that takes a
 * table name instead of SQL is read for that name. The README lists what
 * each method is read as and what the pack leaves out.
 */

import {
  anyOf,
  declaredBy,
  pack,
  returnedBy,
  sqlStatements,
  storageCalls,
} from "@suss/recognize";

import type { PythonPack } from "@suss/adapter-python";
import type { PackDeclaration } from "@suss/ir-core";
import type { OneArgument, PatternPack, SqlMethod } from "@suss/recognize";

/** Spelled the way OpenTelemetry writes its `db.system` values. */
const STORAGE_SYSTEM = "gcp.bigquery";

/** `@suss/sql` looks the dialect up by this name. */
const DIALECT = "bigquery";

const CLIENT_MODULE = "google.cloud.bigquery";

const HOOK_MODULE = "airflow.providers.google.cloud.hooks.bigquery";

const HOOK = declaredBy(HOOK_MODULE);

// The hook documents `get_client` as returning the client library's own
// `Client`, so a chain off it is read the same way.
const CLIENT = anyOf(declaredBy(CLIENT_MODULE), returnedBy("get_client", HOOK));

/** A statement passed first, or under this keyword. */
function statementAt(keyword: string): SqlMethod {
  return { statement: { at: 0, keyword } };
}

/** A table name, written the way a statement writes it, at this pick. */
function tablesAt(
  client: typeof CLIENT | typeof HOOK,
  table: OneArgument,
  kinds: Readonly<Record<string, "read" | "write">>,
) {
  return storageCalls({ system: STORAGE_SYSTEM, client })
    .methods(
      Object.fromEntries(
        Object.entries(kinds).map(([method, kind]) => [method, { kind }]),
      ),
    )
    .container(table, { qualified: true });
}

const CLIENT_STATEMENTS = sqlStatements({
  system: STORAGE_SYSTEM,
  dialect: DIALECT,
  client: CLIENT,
}).methods({
  query: statementAt("query"),
  query_and_wait: statementAt("query"),
});

const CLIENT_TABLES = tablesAt(
  CLIENT,
  { at: 0, keyword: "table" },
  {
    get_table: "read",
    list_rows: "read",
    insert_rows: "write",
    insert_rows_json: "write",
    delete_table: "write",
  },
);

// The loaders take the table second, after the rows they load.
const CLIENT_LOADS = tablesAt(
  CLIENT,
  { at: 1, keyword: "destination" },
  {
    load_table_from_dataframe: "write",
    load_table_from_json: "write",
    load_table_from_uri: "write",
    load_table_from_file: "write",
  },
);

// `insert_job` takes a whole job configuration, with the statement two
// keys down. `run_query` is the older spelling of the same call.
const HOOK_STATEMENTS = sqlStatements({
  system: STORAGE_SYSTEM,
  dialect: DIALECT,
  client: HOOK,
}).methods({
  get_records: statementAt("sql"),
  get_first: statementAt("sql"),
  get_pandas_df: statementAt("sql"),
  run_query: statementAt("sql"),
  insert_job: {
    statement: { at: 0, keyword: "configuration", path: ["query", "query"] },
  },
});

const HOOK_TABLES = tablesAt(
  HOOK,
  { at: 0, keyword: "table_id" },
  { delete_table: "write" },
);

/** The client library's calls and the hook's, each recorded under its own library. */
export function bigqueryPacks(): PatternPack[] {
  return [
    pack(
      "bigquery-python-client",
      [CLIENT_STATEMENTS, CLIENT_TABLES, CLIENT_LOADS],
      { languages: ["python"], recognizedAs: `python-${CLIENT_MODULE}` },
    ),
    pack("bigquery-python-hook", [HOOK_STATEMENTS, HOOK_TABLES], {
      languages: ["python"],
      recognizedAs: `python-${HOOK_MODULE}`,
    }),
  ];
}

/**
 * Adds the BigQuery calls to the route pack a run already uses. A
 * project picks its web framework and its warehouse client separately,
 * so the two packs combine.
 */
export function withBigquery(base: PythonPack): PythonPack {
  const packs = bigqueryPacks();
  return {
    ...base,
    invocationRecognizers: [
      ...(base.invocationRecognizers ?? []),
      ...packs.flatMap((one) => one.invocationRecognizers ?? []),
    ],
    accessRecognizers: [
      ...(base.accessRecognizers ?? []),
      ...packs.flatMap((one) => one.accessRecognizers ?? []),
    ],
  };
}

export function bigqueryFramework(): PythonPack {
  return withBigquery({
    name: "bigquery-python",
    protocol: STORAGE_SYSTEM,
    discovery: [],
  });
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
