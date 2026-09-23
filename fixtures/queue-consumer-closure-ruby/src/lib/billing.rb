# Imported by the orders handler, so it runs in OrdersWorker.

def charge_account(account)
  Faraday.post("https://billing.example.internal/v1/charges", { account: account }.to_json)
end
