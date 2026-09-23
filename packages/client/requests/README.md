# @suss/client-requests

Client pack for [requests](https://requests.readthedocs.io/), the HTTP library most Python services use to call other services, read by the Python adapter.

## What this package is

`@suss/client-requests` exports a `PythonPack` that declares the calls requests offers for making a request. A function that makes one of those calls is a client of the route in its URL:

```python
import requests

def fetch_order(order_id: str) -> dict:
    response = requests.get(f"{ORDERS_BASE}/orders/{order_id}", timeout=5)
    response.raise_for_status()
    return response.json()
```

`fetch_order` comes back as a client of `GET /orders/{order_id}`. It pairs with whatever serves that route in the same run. That can be a FastAPI route in this project, a handler in another repository whose summaries are in the same folder, or an OpenAPI document read with `suss contract`.

- **The seven verb functions**: `get`, `post`, `put`, `patch`, `delete`, `head` and `options`. The function name gives the method, and the URL comes first or as `url=`.
- **`requests.request("PATCH", url)`**: the method is the first argument and the URL the second, and either can be written as `method=` and `url=`.
- **A session**: `session = requests.Session()` accepts the same calls, and a call on it is read the same way.
- **The URL**: read through the same value evaluator a route's path goes through, so an f-string, a name defined elsewhere in the project, and a concatenation all resolve to the path they produce. A URL with a host is reported by its path alone, since a route does not declare a host.
- **What the caller does with the response**: the pack declares `status_code`, `ok` and the body members, and the caller's own tests on them become the paths of its summary. A caller that writes `if response.status_code == 404` handles a 404, and `suss check` reports it when the route on the other side never sends one.

## Where it stops

- **A URL that cannot be settled**, as in `requests.get(target)` where `target` is a parameter, records nothing, so the pack never guesses. The call stays an invocation effect on the function, like any other call.
- **A call at module level** has no function to belong to and is ignored.
- **`raise_for_status()` is not read.** A caller that writes it only handles a 2xx, and the summary does not record that yet. A test the caller writes itself, such as `if response.status_code == 404`, is read.
- **`httpx` and `aiohttp`** are separate libraries with their own packs.

## Usage

```sh
suss extract --dir src -f fastapi -f requests
```

## Where it fits in suss

The pack depends only on `@suss/adapter-python`, for the `PythonPack` type and the `clientCall` pattern it fills in. It has no analysis of its own. Every call it lists belongs to requests, and the adapter does the reading.

## License

Apache-2.0
