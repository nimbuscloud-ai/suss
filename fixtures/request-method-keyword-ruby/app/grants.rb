# Callers of the helpers. Each passes its verb as a keyword, some after
# another keyword, except `list` and `audit`, which leave it out and get
# the default. `relay` passes on whatever verb it was given.

require_relative "http_client"

class Grants
  def list
    HttpClient.new.fetch("https://api.example.com/grants")
  end

  def create(body)
    HttpClient.new.fetch("https://api.example.com/grants", body, verb: :post)
  end

  def revoke(id)
    HttpClient.new.fetch("https://api.example.com/grants/#{id}", verb: :delete)
  end

  def relay(id, verb)
    HttpClient.new.fetch("https://api.example.com/grants/#{id}", verb: verb)
  end

  def renew(id)
    HttpClient.new.send_request("https://api.example.com/grants/#{id}", headers: {}, verb: :put)
  end

  def audit
    HttpClient.new.send_request("https://api.example.com/audit")
  end
end
