# @suss/framework-bigquery-python

Says which BigQuery tables a Python service reads and writes.

## What this package is

A pattern pack for the Python adapter. It emits the same `storage-access` effects the SQLAlchemy pack does, so a table a job reads and a table a job writes are the same kind of boundary whether the store is Postgres or a warehouse.

```ts
import { bigqueryFramework } from "@suss/framework-bigquery-python";

const pack = bigqueryFramework();
```

Two libraries reach the same warehouse, and this covers both. `google-cloud-bigquery` hands a project a `Client`:

```python
from google.cloud import bigquery

client = bigquery.Client()
rows = client.query("SELECT id, name FROM `analytics-prod.core.dim_account` WHERE tier = @tier").result()
```

The Google provider for Airflow hands it a `BigQueryHook`, which wraps one:

```python
from airflow.providers.google.cloud.hooks.bigquery import BigQueryHook

hook = BigQueryHook()
rows = hook.get_records("SELECT id FROM `analytics-prod.core.dim_account`")
```

Both come out as a read of `dim_account` in the `core` dataset, picked by `tier` where the statement says so.

## What each part contributes

| Written as                                          | What it becomes                   |
| --------------------------------------------------- | --------------------------------- |
| the dataset part of `project.dataset.table`           | the scope                         |
| the table part                                        | the container                     |
| the columns the statement spells out                  | the fields                        |
| what its `WHERE` picks rows by                        | the selector                      |
| whether the statement selects or changes rows         | whether the call reads or writes  |

The statement goes through the adapter's value evaluator, so these three read as the same table:

```python
TABLE = "analytics-prod.core.dim_account"
client.query(f"SELECT id FROM `{TABLE}`")
client.query("SELECT id FROM " + "`analytics-prod.core.dim_account`")
client.query(query="SELECT id FROM `analytics-prod.core.dim_account`")
```

A parameter stays a parameter. `@tier` and the values under `job_config` are never read as literals, so what comes out is a selector rather than the value one run happened to pass.

## The calls it reads

Statements on the client: `query`, `query_and_wait`.

Statements on the hook: `get_records`, `get_first`, `get_pandas_df`, `run_query`, and `insert_job`, whose statement is inside the job configuration at `configuration={"query": {"query": sql}}`.

Calls that say which table without writing SQL: `get_table` and `list_rows` read; `insert_rows`, `insert_rows_json`, `delete_table` and the four `load_table_from_*` calls write.

`hook.get_client()` hands back the client library's own `Client`, so a statement run off that chain reads as one too.

## What it will not tell you

A statement whose table the evaluator cannot settle says nothing rather than guessing. `client.query(f"SELECT id FROM `{table}`")` with `table` a function parameter never produces an effect, and neither does a statement a caller handed in. A statement whose project and dataset are unsettled but whose table is written out still reads, with the scope left at `default`.

`BEGIN`, `COMMIT`, `CREATE TABLE` and the rest of the statements that touch a row nowhere are read as nothing.

A table handed over as a `TableReference` or a `Table` object rather than as a string is not read. The pack reads the argument as a string and stops there.

## Where it fits in suss

Depends on `@suss/adapter-python` for the `PythonPack` contract it fills in, and on `@suss/ir-core` for the declaration. The adapter reads the statement with `@suss/sql`, and the storage pass in `@suss/checker` pairs what this emits against whatever declares the table.

```bash
npx suss extract --lang python -f bigquery-python -o summaries/python.json
```

Compose it onto a route pack with `withBigquery(fastapiFramework(...))` when the same run reads a web service as well.
