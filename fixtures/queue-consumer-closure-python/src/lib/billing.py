# Imported by the orders handler, so it runs in OrdersWorker.

import requests


def charge_account(account):
    return requests.post(
        "https://billing.example.internal/v1/charges", json={"account": account}
    )
