# @suss/framework-bigquery-python

This pack records which BigQuery tables a Python service reads and writes.

## What this package is

A pattern pack for the Python adapter. It records the same `storage-access` effects the SQLAlchemy pack does. So a table a job reads or writes is the same kind of boundary whether the store is Postgres or a warehouse.

```ts
import { bigqueryFramework } from "@suss/framework-bigquery-python";

const pack = bigqueryFramework();
```

Two libraries reach the same warehouse, and the pack covers both. `google-cloud-bigquery` gives a project a `Client`:

```python
from google.cloud import bigquery

client = bigquery.Client()
rows = client.query("SELECT id, name FROM `analytics-prod.core.dim_account` WHERE tier = @tier").result()
```

The Google provider for Airflow gives it a `BigQueryHook`, which wraps a client:

```python
from airflow.providers.google.cloud.hooks.bigquery import BigQueryHook

hook = BigQueryHook()
rows = hook.get_records("SELECT id FROM `analytics-prod.core.dim_account`")
```

Both come out as a read of `dim_account` in the `core` dataset, selected by `tier` where the statement has a `WHERE` on it.

## What each part contributes

| Written as                                          | What it becomes                   |
| --------------------------------------------------- | --------------------------------- |
| the dataset part of `project.dataset.table`           | the scope                         |
| the table part                                        | the container                     |
| the columns the statement spells out                  | the fields                        |
| what its `WHERE` picks rows by                        | the selector                      |
| whether the statement selects or changes rows         | whether the call reads or writes  |

The statement goes through the adapter's value evaluator, so these three are read as the same table:

```python
TABLE = "analytics-prod.core.dim_account"
client.query(f"SELECT id FROM `{TABLE}`")
client.query("SELECT id FROM " + "`analytics-prod.core.dim_account`")
client.query(query="SELECT id FROM `analytics-prod.core.dim_account`")
```

A parameter stays a parameter. `@tier` and the values under `job_config` are never read as literals, so the result is a selector and does not depend on the value one run happened to pass.

## The calls it reads

Statements on the client: `query`, `query_and_wait`.

Statements on the hook: `get_records`, `get_first`, `get_pandas_df`, `run_query`, and `insert_job`, whose statement is inside the job configuration at `configuration={"query": {"query": sql}}`.

Calls that reach a table without SQL: `get_table` and `list_rows` read. `insert_rows`, `insert_rows_json`, `delete_table` and the four `load_table_from_*` calls write.

`hook.get_client()` returns the client library's own `Client`, so a statement run through that chain is read as well.

## What it will not tell you

When the evaluator cannot settle a statement's table, the pack records nothing instead of guessing. `client.query(f"SELECT id FROM `{table}`")`, where `table` is a function parameter, never produces an effect, and neither does a statement a caller passed in. A statement whose project and dataset cannot be settled, but whose table is written out, is still read, with the scope left at `default`.

`BEGIN`, `COMMIT`, `CREATE TABLE` and other statements that do not touch any row produce nothing.

A table passed as a `TableReference` or a `Table` object is not read. The pack reads the argument as a string and stops there.

## Where it fits in suss

The pack depends on `@suss/adapter-python` for the `PythonPack` contract it fills in, and on `@suss/ir-core` for the declaration. The adapter reads the statement with `@suss/sql`, and the storage pass in `@suss/checker` pairs what this pack records with whatever declares the table.

```bash
npx suss extract --lang python -f bigquery-python -o summaries/python.json
```

When the same run also reads a web service, combine this pack with a route pack using `withBigquery(fastapiFramework(...))`.
