# Prints what Faraday and Net::HTTP would request for each case read from
# stdin, without sending anything. The client URL check runs it, and the
# differential's README says how each library is stopped before it sends.

require "json"
require "uri"
require "faraday"
require "net/http"

class Built < StandardError
  attr_reader :result

  def initialize(result)
    super(result.to_s)
    @result = result
  end
end

class BadHost < StandardError; end

class StopBeforeSending < Faraday::Middleware
  def call(env)
    raise Built.new({ "url" => env.url.to_s })
  end
end

# Net::HTTP learns that an address is not a host name from DNS, which needs
# the network, so connect checks the name's syntax instead.
module WriteNothing
  def connect
    URI::HTTP.build(host: address)
  rescue URI::InvalidComponentError
    raise BadHost, "#{address.inspect} is not a host name"
  end

  def transport_request(req)
    scheme = use_ssl? ? "https" : "http"
    raise Built.new({ "origin" => "#{scheme}://#{address}:#{port}", "target" => req.path })
  end
end

Net::HTTP.prepend(WriteNothing)

def refused(error, base)
  { "refused" => "#{error.class}: #{error.message}", "base" => base }
end

def faraday_connection(base)
  return Faraday.new { |f| f.use StopBeforeSending } if base.nil?

  Faraday.new(url: base) { |f| f.use StopBeforeSending }
end

def faraday_call(kase)
  faraday_connection(kase["base"]).get(kase["path"])
  raise "Faraday sent #{kase["id"]} past its middleware"
rescue Built => built
  built.result
rescue StandardError => error
  refused(error, false)
end

NET_HTTP_FORMS = {
  "get" => ->(kase) { Net::HTTP.get(kase["base"], kase["path"], kase["port"]) },
  "new" => ->(kase) { Net::HTTP.new(kase["base"], kase["port"]).get(kase["path"]) },
  "request" => lambda do |kase|
    Net::HTTP.new(kase["base"], kase["port"]).request(Net::HTTP::Get.new(kase["path"]))
  end,
  "uri" => ->(kase) { Net::HTTP.get(URI(kase["path"])) },
}.freeze

def net_http_call(kase)
  NET_HTTP_FORMS.fetch(kase["form"]).call(kase)
  raise "Net::HTTP sent #{kase["id"]} without writing it"
rescue Built => built
  built.result
rescue BadHost => error
  refused(error, true)
rescue StandardError => error
  refused(error, false)
end

CALLS = { "faraday" => method(:faraday_call), "net-http" => method(:net_http_call) }.freeze

results = JSON.parse($stdin.read).map do |kase|
  { "id" => kase["id"] }.merge(CALLS.fetch(kase["library"]).call(kase))
end
puts JSON.generate(results)
