import os

import httpx

# The shop's address, which the deployment sets.
SHOP_API_URL = os.environ["SHOP_API_URL"]


def sync_order(event, context):
    summary = httpx.get(f"{SHOP_API_URL}/orders/{event['id']}/summary")
    totals = httpx.get(f"{SHOP_API_URL}/orders/{event['id']}/totals")
    return {"summary": summary.json(), "totals": totals.json()}


def fetch_logo(event, context):
    return httpx.get(f"{SHOP_API_URL}/assets/logo.png").content


def fetch_metrics(event, context):
    return httpx.get(f"{SHOP_API_URL}/metrics").text


def fetch_export(event, context):
    return httpx.get(f"{SHOP_API_URL}/files/exports/{event['id']}/report.csv").content
