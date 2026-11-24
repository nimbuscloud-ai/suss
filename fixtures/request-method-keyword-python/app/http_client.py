# Helpers whose method comes after a body parameter, so callers pass it
# by keyword. `fetch` picks its requests call by the method, and `send`
# hands it to the library. A caller that passes none sends a GET.

import requests


def fetch(url, body=None, method="get"):
    if method == "get":
        return requests.get(url)
    if method == "delete":
        return requests.delete(url)
    return requests.post(url, json=body)


def send(url, body=None, *, method="GET", headers=None):
    return requests.request(method, url, json=body, headers=headers)
