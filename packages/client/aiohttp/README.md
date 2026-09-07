# @suss/client-aiohttp

Client pack for [aiohttp](https://docs.aiohttp.org/), read by the Python adapter.

## What this package is

`@suss/client-aiohttp` returns a `PythonPack` describing the calls an aiohttp session gives a project. A function that makes one is a client of the route that call names:

```python
import aiohttp

async def fetch_order(order_id: str) -> dict:
    async with aiohttp.ClientSession() as session:
        async with session.get(f"/orders/{order_id}") as response:
            return await response.json()
```

`fetch_order` comes back as a client of `GET /orders/{order_id}`, which pairs with whatever serves that route in the same run.

- **The session methods**: `get`, `post`, `put`, `patch`, `delete`, `head` and `options`, each taking the URL first or under `url=`, and `session.request("PATCH", url)`.
- **The session**: `aiohttp.ClientSession()` opened with `async with` or held in a plain assignment, both in the function that makes the call.
- **The URL**: read through the same value evaluator a route's path goes through.

## Where it stops

- **A session built somewhere else**, passed in as a parameter or held on `self`, is not followed, so a call on it says nothing. That is the shape a long-lived session takes in a large service, and closing it needs the transitive consumer contract rather than a one-hop read.
- **`base_url` on a session is not read**, so a call is reported by its own path alone.
- **What the response says** is not read yet.

## Usage

```sh
suss extract --dir src -f fastapi -f aiohttp
```

## Where it fits in suss

Depends only on `@suss/adapter-python`, for the `PythonPack` type and the client-call declaration it fills in.

## License

Apache-2.0
