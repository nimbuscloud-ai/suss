# Callers of the client, each passing its own verb, directly or through
# the helper for that verb.

class Grants
  def list
    HttpClient.new.get("https://api.example.com/grants")
  end

  def create(body)
    HttpClient.new.post("https://api.example.com/grants", body)
  end

  def revoke(id)
    HttpClient.new.fetch("https://api.example.com/grants/#{id}", :delete)
  end
end
