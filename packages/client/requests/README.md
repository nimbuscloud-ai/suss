# @suss/client-requests

Client pack for [requests](https://requests.readthedocs.io/), the HTTP library most Python services call other services with, read by the Python adapter.

## What this package is

`@suss/client-requests` returns a `PythonPack` describing the calls requests gives a project for making a request. A function that makes one is a client of the route that call names:

```python
import requests

def fetch_order(order_id: str) -> dict:
    response = requests.get(f"{ORDERS_BASE}/orders/{order_id}", timeout=5)
    response.raise_for_status()
    return response.json()
```

`fetch_order` comes back as a client of `GET /orders/{order_id}`, which pairs with whatever serves that route in the same run: a FastAPI route in this project, a handler in another repository read into the same folder of summaries, or an OpenAPI document read with `suss contract`.

- **The seven verb functions**: `get`, `post`, `put`, `patch`, `delete`, `head` and `options` each say the method themselves and take the URL first, or under `url=`.
- **`requests.request("PATCH", url)`**: the method is the first argument and the URL is the second, and both may be written as `method=` and `url=`.
- **A session**: `session = requests.Session()` takes the same calls, and a call on it reads the same way.
- **The URL**: read through the same value evaluator a route's path goes through, so an f-string, a name defined elsewhere in the project, and a concatenation all read to the path they come to. A URL with a host is reported by its path alone, since the host is no part of what a route declares.

## Where it stops

- **A URL nothing can settle**, `requests.get(target)` where `target` is a parameter, says nothing rather than guessing, and the call stays an invocation effect on the function like any other call.
- **A call at module level** has no function to belong to and is left alone.
- **What the response says** is not read yet. `raise_for_status()`, `response.status_code == 404` and `response.json()` tell a reader which statuses the caller expects and what it does with the body, and none of that reaches the summary. The pack reports the boundary a function reaches, not what it does with the answer.
- **`httpx` and `aiohttp`** are their own libraries and get their own packs.

## Usage

```sh
suss extract --dir src -f fastapi -f requests
```

## Where it fits in suss

Depends only on `@suss/adapter-python`, for the `PythonPack` type and the `clientCall` pattern it fills in. It contains no analysis of its own: every call it names belongs to requests, and the adapter does the reading.

## License

Apache-2.0
