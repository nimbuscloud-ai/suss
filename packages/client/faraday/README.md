# @suss/client-faraday

Client pack for [Faraday](https://lostisland.github.io/faraday/), the HTTP library most Ruby services call other services with, read by the Ruby adapter.

## What this package is

`@suss/client-faraday` returns a `RubyPack` describing the calls Faraday gives a project for making a request. A method that makes one is a client of the route that call names:

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

`fetch` comes back as a client of `GET /orders/{id}` and `create` as a client of `POST /v1/orders`, which pair with whatever serves those routes in the same run: a Rails action in this project, a handler from another repository read into the same folder of summaries, or an OpenAPI document read with `suss contract`.

- **The request methods**: `get`, `post`, `put`, `patch`, `delete`, `head` and `options`, on the module itself and on a connection alike, each taking the URL first.
- **A connection**: `conn = Faraday.new(url: ...)` in the same method, then a call on `conn`. The base URL's own path comes in front of the call's, so a connection on `/v1` serves `/v1/orders`.
- **The URL**: read through the same value evaluator a Rails route path goes through, so `"#{ORDERS_BASE}/orders/#{id}"` reads to `/orders/{id}`. A URL with a host is reported by its path alone, since the host is no part of what a route declares.

## Where it stops

- **A URL nothing can settle**, `Faraday.get(target)` where `target` is a parameter, says nothing rather than guessing, and the call stays an invocation effect like any other.
- **A connection built somewhere else**, in another method or in an initializer, is not followed: the assignment has to be in the method that makes the call, which is the one-hop limit every other reader here takes.
- **A block-configured request**, `conn.post("/orders") { |req| ... }`, is read for its path and method; what the block sets on the request is not.
- **What the response says** is not read yet. `response.status`, `response.success?` and `response.body` tell a reader which statuses the caller expects, and none of that reaches the summary.
- **Net::HTTP, HTTParty and RestClient** are their own libraries and get their own packs.

## Usage

```sh
suss extract --dir app -f rails -f faraday
```

## Where it fits in suss

Depends only on `@suss/adapter-ruby`, for the `RubyPack` type and the client-call declaration it fills in. It contains no analysis of its own: every name it states belongs to Faraday, and the adapter does the reading.

## License

Apache-2.0
