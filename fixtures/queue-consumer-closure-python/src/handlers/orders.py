# Runs in OrdersWorker, which drains OrdersQueue. Both calls it makes
# happen again when the queue delivers a message twice: the one here
# and the one inside the billing helper it imports.

import json

import requests

from src.lib.billing import charge_account


def post_receipt(order_id):
    return requests.post(
        "https://orders.example.internal/v1/receipts", json={"order_id": order_id}
    )


def handler(event, context):
    for record in event["Records"]:
        order = json.loads(record["body"])
        post_receipt(order["id"])
        charge_account(order["account"])
