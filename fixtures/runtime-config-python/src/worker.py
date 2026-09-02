# Runs in WorkerFunction. QUEUE_URL is declared on that function and on
# no other, and nothing in app.py imports this module, so the read
# pairs with the worker alone.

import os

QUEUE_URL = os.environ["QUEUE_URL"]


def handler(event, context):
    return {"queue": QUEUE_URL, "records": len(event.get("Records", []))}
