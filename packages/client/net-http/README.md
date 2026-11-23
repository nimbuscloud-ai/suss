# @suss/client-net-http

Client pack for [Net::HTTP](https://docs.ruby-lang.org/en/master/Net/HTTP.html), the HTTP client in Ruby's own standard library, read by the Ruby adapter.

## What this package is

`@suss/client-net-http` exports a `RubyPack` that declares the calls Net::HTTP offers. A method that makes one of those calls is a client of the route in its URL. The library can be used in two ways, and the pack reads both:

```ruby
class OrderClient
  def fetch(id)
    Net::HTTP.get(URI("https://api.example.com/orders/#{id}"))
  end

  def create(body)
    uri = URI("https://api.example.com/orders")
    http = Net::HTTP.new(uri.host, uri.port)
    request = Net::HTTP::Post.new(uri)
    request.body = body
    http.request(request)
  end
end
```

`fetch` comes back as a client of `GET /orders/{id}`, and `create` as a client of `POST /orders`.

- **The module methods that send a request directly**: `get`, `get_response`, `get_print`, `post`, `post_form`, `put`, `patch`, `delete`, `head` and `options`.
- **A host and a path given apart**: `Net::HTTP.get("api.example.com", "/orders", 8080)` is a client of `GET /orders` at `api.example.com:8080`. The three get methods take this form when their second argument is a path, the same test Ruby makes. When it is a hash, it is the headers, and the first argument is the URL.
- **A connection built on a host**: `Net::HTTP.new("api.example.com", 8080)` takes a host and a port, so `http.get("/orders")` on it goes to `/orders` at that host. A port of 80 is left out of the host, the way a URL leaves out its default port.
- **`send_request(method, path)` on a connection**, which sends the method it is given. When that method is a parameter of the method the call is in and nothing settles it, the client has a null method, and its `bindingFrom` says the method is that parameter.
- **The request classes**: `Net::HTTP::Get` and its six siblings give the method, and the URL is the argument the class was built with. The request can be built in the call itself, or assigned to a name earlier in the same method.
- **The URL**: `URI(...)` and `URI.parse(...)` are part of Ruby itself, so the adapter's own value tables read them and this pack does not declare them. A URI written in the call and one kept in a local are read the same way, and an interpolated path resolves to the path parameter in it.

## Where it stops

- **`Net::HTTP.start(host, port) { |http| ... }`** passes the connection to a block parameter, and a call on that parameter is not read. A connection assigned to a name with `Net::HTTP.new` is read.
- **A URI built somewhere else**, in another method or from a value that cannot be settled, makes the method a client with no path, so the pack never guesses. A binding with no path pairs with nothing.
- **A request's body and headers** are not read. The request is reported by its method and path alone, and what `request.body =` sets is ignored.
- **What the caller does with the response**: the pack declares `code` and `body`, and a test the caller writes on either one becomes a path of its summary. Net::HTTP returns the status as a string, so `response.code.to_i == 404` is read as a test on `code`.

## Usage

```sh
suss extract --dir app -f rails -f net-http
```

## Where it fits in suss

The pack declares its calls with `@suss/recognize`'s `httpRequests`, as two chains: the calls on `Net::HTTP` itself, and the same calls on a connection `Net::HTTP.new` opened. It depends on `@suss/adapter-ruby` for the `RubyPack` type, and the adapter's client walk hands each call in a method body to both.

## License

Apache-2.0
