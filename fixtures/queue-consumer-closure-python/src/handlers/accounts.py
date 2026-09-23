# Runs in AccountsFunction behind an HTTP route. Nothing here reads the
# queue, so its call is not the worker's to repeat.

import requests


def create_account(body):
    return requests.post("https://accounts.example.internal/v1/accounts", data=body)


def handler(event, context):
    create_account(event["body"])
    return {"statusCode": 201}
