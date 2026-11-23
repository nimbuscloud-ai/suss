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
    conn.post("orders", body)
  end
end
```

`fetch` comes back as a client of `GET /orders/{id}`, and `create` as a client of `POST /v1/orders`. They pair with whatever serves those routes in the same run. That can be a Rails action in this project, a handler from another repository whose summaries are in the same folder, or an OpenAPI document read with `suss contract`.

- **The request methods**: `get`, `post`, `put`, `patch`, `delete`, `head` and `options`, on the module itself or on a connection, each taking the URL first.
- **`run_request(method, url, body, headers)`**, which sends the method it is given. When that method is a parameter of the method the call is in and nothing settles it, the client has a null method, and its `bindingFrom` says the method is that parameter.
- **A connection**: `conn = Faraday.new(url: ...)`, followed by a call on `conn`. The connection can be a local, an instance variable the class sets, or a method of the class that returns it. The call's path is resolved against the base URL the way Faraday resolves it, which follows RFC 3986. On a connection built on `/v1`, `conn.post("orders")` goes to `/v1/orders`, and `conn.post("/orders")` goes to `/orders`, because a path that starts with a slash replaces the base's path.
- **The URL**: read through the same value evaluator a Rails route path goes through, so `"#{ORDERS_BASE}/orders/#{id}"` resolves to `/orders/{id}`. A URL with a host is reported by its path alone, since a route does not declare a host.

## Where it stops

- **A URL that cannot be settled**, as in `Faraday.get(target)` where `target` is a parameter, makes the method a client with no path, so the pack never guesses. A binding with no path pairs with nothing. A path made only of holes, as in `"#{base}#{path}"`, counts as no path, unless suss read the host.
- **A connection handed in from outside the class**, such as a parameter, is not followed.
- **A request configured in a block**, `conn.post("/orders") { |req| ... }`, is read for its path and method. What the block sets on the request is not read.
- **What the caller does with the response**: the pack declares `status`, `success?` and `body`, and the caller's own tests on them become the paths of its summary. A caller that writes `return nil if response.status == 404` handles a 404, and `suss check` reports it when the route on the other side never sends one.
- **Net::HTTP, HTTParty and RestClient** are separate libraries with their own packs.

## Usage

```sh
suss extract --dir app -f rails -f faraday
```

## Where it fits in suss

The pack declares its calls with `@suss/recognize`'s `httpRequests`, and depends on `@suss/adapter-ruby` for the `RubyPack` type. It has no analysis of its own. Every name it lists belongs to Faraday, and the adapter's client walk hands each call in a method body to the declaration.

## License

Apache-2.0
