# @suss/client-net-http

Client pack for [Net::HTTP](https://docs.ruby-lang.org/en/master/Net/HTTP.html), the HTTP client in Ruby's own standard library, read by the Ruby adapter.

## What this package is

`@suss/client-net-http` returns a `RubyPack` describing the calls Net::HTTP gives a project. A method that makes one is a client of the route that call names, in either of the two ways the library is written:

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

`fetch` comes back as a client of `GET /orders/{id}` and `create` as a client of `POST /orders`.

- **The module methods that send on their own**: `get`, `get_response`, `post`, `post_form`, `put`, `patch`, `delete`, `head` and `options`.
- **The request classes**: `Net::HTTP::Get` and its six siblings say the method, and the URL is the argument the class was built with. The request may be built in the call itself or assigned to a name in the same method first.
- **The URL**: `URI(...)` and `URI.parse(...)` belong to Ruby rather than to Net::HTTP, so the adapter's own value tables read them, and this pack says nothing about them. A URI written in the call and one held in a local read the same way, and an interpolated path reads to the path parameter it states.

## Where it stops

- **`Net::HTTP.start(host, port) { |http| ... }`** hands the connection to a block parameter, and a call on that parameter is not read. A connection assigned to a name with `Net::HTTP.new` is.
- **A URI built somewhere else**, in another method or from a value nothing settles, says nothing rather than guessing.
- **A request whose body or headers matter** is reported by its method and path alone; what `request.body =` sets is not read.
- **What the caller does with the response**: `code` and `body` are declared here, and a test the caller writes on one of them becomes a path of its summary. The status comes back as a string, so `response.code.to_i == 404` is read as a test on `code`.

## Usage

```sh
suss extract --dir app -f rails -f net-http
```

## Where it fits in suss

Depends only on `@suss/adapter-ruby`, for the `RubyPack` type and the client-call declaration it fills in.

## License

Apache-2.0
