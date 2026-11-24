# Callers that pass the method by keyword, some in another order than the
# parameters. `list_grants` and `audit` leave it out and get the default,
# and `relay` passes on whatever method it was given.

from app.http_client import fetch, send


def list_grants():
    return fetch("https://api.example.com/grants")


def create_grant(body):
    return fetch("https://api.example.com/grants", method="post", body=body)


def revoke_grant(grant_id):
    return fetch(f"https://api.example.com/grants/{grant_id}", method="delete")


def relay(grant_id, method):
    return fetch(f"https://api.example.com/grants/{grant_id}", method=method)


def renew_grant(grant_id):
    return send(f"https://api.example.com/grants/{grant_id}", headers={}, method="PUT")


def audit():
    return send("https://api.example.com/audit")
