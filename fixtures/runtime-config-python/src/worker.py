# Runs in WorkerFunction. QUEUE_URL is declared on that function and on
# no other, and nothing in app.py imports this module, so the read
# pairs with the worker alone.

import os

from clients import QueueClient
from env import require_env

QUEUE_URL = os.environ["QUEUE_URL"]
CHECKED_QUEUE_URL = require_env("QUEUE_URL")


def handler(event, context):
    client = QueueClient()
    return {"queue": client.url, "records": len(event.get("Records", []))}
