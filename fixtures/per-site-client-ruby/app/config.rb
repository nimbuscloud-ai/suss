# Runtime configuration, read once by whoever builds a client out of it.

def load_config
  response = Faraday.get("/config")
  JSON.parse(response.body, symbolize_names: true)
end
