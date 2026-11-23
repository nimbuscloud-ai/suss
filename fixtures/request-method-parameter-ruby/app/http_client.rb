# Two helpers that take the HTTP method from their caller. `fetch` picks
# its Net::HTTP call by the verb it is passed, and `send_request` hands
# the verb straight to Faraday. A caller that passes no verb sends a GET.

require "net/http"
require "faraday"

class HttpClient
  def fetch(url, method = :get, body = nil)
    uri = URI.parse(url)
    host = Net::HTTP.new(uri.host, uri.port)
    if method == :get
      host.get(uri.path)
    elsif method == :delete
      host.request(Net::HTTP::Delete.new(uri.path))
    elsif method == :post
      host.post(uri.path, body)
    end
  end

  def send_request(url, verb = :get, body = nil)
    Faraday.new.run_request(verb, url, body, {})
  end

  def send_raw(path, verb = "GET")
    Net::HTTP.new("api.example.com", 443).send_request(verb, path)
  end
end
