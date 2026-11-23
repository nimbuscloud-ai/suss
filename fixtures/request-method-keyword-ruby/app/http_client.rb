# Two helpers that take the HTTP verb as a keyword argument. `fetch`
# picks its Net::HTTP call by the verb, and `send_request` hands the
# verb straight to Faraday. A caller that passes no verb sends a GET.

require "net/http"
require "faraday"

class HttpClient
  def fetch(url, body = nil, verb: :get)
    uri = URI.parse(url)
    host = Net::HTTP.new(uri.host, uri.port)
    if verb == :get
      host.get(uri.path)
    elsif verb == :delete
      host.request(Net::HTTP::Delete.new(uri.path))
    else
      host.post(uri.path, body)
    end
  end

  def send_request(url, body = nil, verb: :get, headers: {})
    Faraday.new.run_request(verb, url, body, headers)
  end
end
