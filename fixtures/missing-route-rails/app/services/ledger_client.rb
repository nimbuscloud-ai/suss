# The ledger is another service, at an address the deployment sets.
class LedgerClient
  BASE = ENV.fetch("LEDGER_API_URL", "")

  def entries
    Faraday.new(url: BASE).get("/ledger/entries")
  end

  def balances
    Faraday.new(url: ENV["LEDGER_API_URL"]).get("/ledger/balances")
  end
end
