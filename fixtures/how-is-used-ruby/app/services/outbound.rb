# Every outbound request goes through here, with the verb the caller
# passes deciding which Net::HTTP call runs.

require "net/http"

class Outbound
  class Refused < StandardError; end

  def fetch(url, method = :get)
    uri = URI.parse(url)
    raise Refused if uri.host.nil?

    host = Net::HTTP.new(uri.host, uri.port)
    case method
    when :post
      host.post(uri.path, "")
    when :put
      host.request(Net::HTTP::Put.new(uri.path))
    else
      host.get(uri.path)
    end
  end
end
