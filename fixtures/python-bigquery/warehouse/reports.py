# Each function reaches BigQuery a different way: a statement under a
# keyword, a table name instead of SQL, a statement inside the job
# configuration a hook takes, and a client the hook hands back.

from airflow.providers.google.cloud.hooks.bigquery import BigQueryHook
from google.cloud import bigquery

DATASET = "analytics"


def active_accounts(client: bigquery.Client):
    return client.query(query="SELECT id, email FROM analytics.accounts WHERE active").result()


def daily_totals():
    client = bigquery.Client()
    return client.query_and_wait(f"SELECT day, total FROM {DATASET}.daily_totals")


def load_events(client: bigquery.Client, rows):
    client.load_table_from_json(rows, destination="analytics.events")
    return client.get_table("analytics.events")


def rebuild_rollup():
    hook = BigQueryHook(gcp_conn_id="warehouse")
    hook.insert_job(
        configuration={
            "query": {
                "query": "INSERT INTO analytics.rollup SELECT day, total FROM analytics.daily_totals",
                "useLegacySql": False,
            }
        }
    )
    hook.delete_table(table_id="analytics.rollup_staging")
    return hook.get_records(sql="SELECT COUNT(*) FROM analytics.rollup")


def stale_accounts():
    hook = BigQueryHook(gcp_conn_id="warehouse")
    return hook.get_client().query("SELECT id FROM analytics.accounts WHERE last_seen < CURRENT_DATE()")
