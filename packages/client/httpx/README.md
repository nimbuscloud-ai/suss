# @suss/client-httpx

Client pack for [httpx](https://www.python-httpx.org/), read by the Python adapter.

## What this package is

`@suss/client-httpx` returns a `PythonPack` describing the calls httpx gives a project for making a request. A function that makes one is a client of the route that call names:

```python
import httpx

def fetch_order(order_id: str) -> dict:
    with httpx.Client(base_url=ORDERS_BASE) as client:
        return client.get(f"/orders/{order_id}").json()
```

`fetch_order` comes back as a client of `GET /orders/{order_id}`, which pairs with whatever serves that route in the same run.

- **The verb functions**: `get`, `post`, `put`, `patch`, `delete`, `head` and `options`, each taking the URL first or under `url=`.
- **`httpx.request("PATCH", url)`**: the method is the first argument and the URL is the second, and both may be written as keywords.
- **A client**: `httpx.Client()` and `httpx.AsyncClient()` take the same calls, whether a project assigns one to a name or opens it as a context manager with `with` or `async with`.
- **The URL**: read through the same value evaluator a route's path goes through, so an f-string and a name defined elsewhere both read to the path they come to.

## Where it stops

- **`base_url` on a client is not read**, so a call on a client built with one is reported by its own path alone. The Faraday pack reads Faraday's `url:` because Faraday states a path there; httpx's `base_url` is read the same way once there is a case for it.
- **A URL nothing can settle** says nothing rather than guessing, and so does a call at module level.
- **What the response says**, `raise_for_status()` and `response.status_code`, is not read yet.

## Usage

```sh
suss extract --dir src -f fastapi -f httpx
```

## Where it fits in suss

Depends only on `@suss/adapter-python`, for the `PythonPack` type and the client-call declaration it fills in.

## License

Apache-2.0
