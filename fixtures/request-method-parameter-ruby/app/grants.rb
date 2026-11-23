# Callers of the helpers. Each passes its own verb, except `list` and
# `audit`, which leave it out and get the default.

require_relative "http_client"

class Grants
  def list
    HttpClient.new.fetch("https://api.example.com/grants")
  end

  def create(body)
    HttpClient.new.fetch("https://api.example.com/grants", :post, body)
  end

  def revoke(id)
    HttpClient.new.fetch("https://api.example.com/grants/#{id}", :delete)
  end

  def renew(id)
    HttpClient.new.send_request("https://api.example.com/grants/#{id}", :put)
  end

  def audit
    HttpClient.new.send_request("https://api.example.com/audit")
  end

  def purge(id)
    HttpClient.new.send_raw("/grants/#{id}", "DELETE")
  end
end
