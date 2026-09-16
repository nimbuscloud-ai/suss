# A client given an API key when it is made, built inside a factory out
# of a value the config call came back with.

class ReportsClient
  def initialize(api_key)
    @api_key = api_key
  end

  def fetch_daily
    Faraday.get("/reports/daily", { "X-Api-Key" => @api_key })
  end
end

def reports_client
  config = load_config
  ReportsClient.new(config[:api_key])
end
