# Callers of the helpers. Each passes its own method, except `list_grants`
# and `audit`, which leave it out and get the default.

from app.http_client import fetch, send, send_aiohttp, send_httpx


def list_grants():
    return fetch("https://api.example.com/grants")


def create_grant(body):
    return fetch("https://api.example.com/grants", "post", body)


def revoke_grant(grant_id):
    return fetch(f"https://api.example.com/grants/{grant_id}", method="delete")


def renew_grant(grant_id):
    return send(f"https://api.example.com/grants/{grant_id}", "PUT")


def audit():
    return send("https://api.example.com/audit")


def purge_grant(grant_id):
    return send_httpx(f"https://api.example.com/grants/{grant_id}", method="DELETE")


async def watch_grants():
    return await send_aiohttp("https://api.example.com/grants/watch", "POST")
