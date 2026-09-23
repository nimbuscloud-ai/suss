# A one-off script run by hand. It is inside the functions' CodeUri,
# and no handler imports it.

import requests


def backfill_refund(refund_id):
    return requests.post(
        "https://billing.example.internal/v1/refunds", json={"id": refund_id}
    )
