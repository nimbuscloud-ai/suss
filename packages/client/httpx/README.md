# @suss/client-httpx

Client pack for [httpx](https://www.python-httpx.org/), read by the Python adapter.

## What this package is

`@suss/client-httpx` exports a `PythonPack` that declares the calls httpx offers for making a request. A function that makes one of those calls is a client of the route in its URL:

```python
import httpx

def fetch_order(order_id: str) -> dict:
    with httpx.Client(base_url=ORDERS_BASE) as client:
        return client.get(f"/orders/{order_id}").json()
```

`fetch_order` comes back as a client of `GET /orders/{order_id}`, which pairs with whatever serves that route in the same run.

- **The verb functions**: `get`, `post`, `put`, `patch`, `delete`, `head` and `options`, each taking the URL first or as `url=`.
- **`httpx.request("PATCH", url)`**: the method is the first argument and the URL the second, and either can be written as a keyword.
- **A client**: `httpx.Client()` and `httpx.AsyncClient()` accept the same calls, whether the project assigns the client to a name or opens it as a context manager with `with` or `async with`.
- **The URL**: read through the same value evaluator a route's path goes through, so an f-string and a name defined elsewhere both resolve to the path they produce.

## Where it stops

- **`base_url` on a client is not read**, so a call on a client built with one is reported by its own path alone. The Faraday pack reads Faraday's `url:`, because Faraday puts a path there. httpx's `base_url` will be read the same way once a project needs it.
- **A URL that cannot be settled** records nothing, so the pack never guesses. A call at module level records nothing either.
- **The response**, meaning `raise_for_status()` and `response.status_code`, is not read yet.

## Usage

```sh
suss extract --dir src -f fastapi -f httpx
```

## Where it fits in suss

The pack depends only on `@suss/adapter-python`, for the `PythonPack` type and the client-call declaration it fills in.

## License

Apache-2.0
