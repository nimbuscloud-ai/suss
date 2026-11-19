# A client whose one method sends every request, with the verb its
# caller passes deciding which Net::HTTP call runs. The URL comes from the
# caller too, so none of the requests settles a path here.

require "net/http"

class HttpClient
  def fetch(url, method = :get, body = nil)
    uri = URI.parse(url)
    host = Net::HTTP.new(uri.host, uri.port)
    case method
    when :get
      host.get(uri.path)
    when :delete
      host.request(Net::HTTP::Delete.new(uri.path))
    when :post
      host.post(uri.path, body)
    end
  end

  def get(url)
    fetch(url, :get)
  end

  def post(url, body)
    fetch(url, :post, body)
  end
end
