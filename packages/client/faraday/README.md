# @suss/client-faraday

Client pack for [Faraday](https://lostisland.github.io/faraday/), the HTTP library most Ruby services use to call other services, read by the Ruby adapter.

## What this package is

`@suss/client-faraday` exports a `RubyPack` that declares the calls Faraday offers for making a request. A method that makes one of those calls is a client of the route in its URL:

```ruby
class OrderClient
  def fetch(id)
    Faraday.get("https://api.example.com/orders/#{id}")
  end

  def create(body)
    conn = Faraday.new(url: "https://api.example.com/v1")
    conn.post("/orders", body)
  end
end
```

`fetch` comes back as a client of `GET /orders/{id}`, and `create` as a client of `POST /v1/orders`. They pair with whatever serves those routes in the same run. That can be a Rails action in this project, a handler from another repository whose summaries are in the same folder, or an OpenAPI document read with `suss contract`.

- **The request methods**: `get`, `post`, `put`, `patch`, `delete`, `head` and `options`, on the module itself or on a connection, each taking the URL first.
- **A connection**: `conn = Faraday.new(url: ...)` in the same method, followed by a call on `conn`. The path in the base URL goes in front of the call's path, so a connection on `/v1` serves `/v1/orders`.
- **The URL**: read through the same value evaluator a Rails route path goes through, so `"#{ORDERS_BASE}/orders/#{id}"` resolves to `/orders/{id}`. A URL with a host is reported by its path alone, since a route does not declare a host.

## Where it stops

- **A URL that cannot be settled**, as in `Faraday.get(target)` where `target` is a parameter, records nothing, so the pack never guesses. The call stays an invocation effect like any other.
- **A connection built somewhere else**, in another method or in an initializer, is not followed. The assignment has to be in the method that makes the call, which is the same one-hop limit every other reader here has.
- **A request configured in a block**, `conn.post("/orders") { |req| ... }`, is read for its path and method. What the block sets on the request is not read.
- **What the caller does with the response**: the pack declares `status`, `success?` and `body`, and the caller's own tests on them become the paths of its summary. A caller that writes `return nil if response.status == 404` handles a 404, and `suss check` reports it when the route on the other side never sends one.
- **Net::HTTP, HTTParty and RestClient** are separate libraries with their own packs.

## Usage

```sh
suss extract --dir app -f rails -f faraday
```

## Where it fits in suss

The pack depends only on `@suss/adapter-ruby`, for the `RubyPack` type and the client-call declaration it fills in. It has no analysis of its own. Every name it lists belongs to Faraday, and the adapter does the reading.

## License

Apache-2.0
