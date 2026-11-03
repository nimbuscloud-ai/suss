# A job a scheduler runs as `python -m warehouse.nightly`. The work runs
# while the module loads.

from google.cloud import bigquery

from warehouse.reports import (
    active_accounts,
    daily_totals,
    load_events,
    rebuild_rollup,
    stale_accounts,
)

client = bigquery.Client()

active_accounts(client)
daily_totals()
load_events(client, [{"id": 1}])
rebuild_rollup()
stale_accounts()
