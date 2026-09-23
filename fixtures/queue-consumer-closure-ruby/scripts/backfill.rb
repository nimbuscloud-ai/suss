# A one-off script run by hand. It is inside the functions' CodeUri,
# and no handler imports it.

def backfill_refund(refund_id)
  Faraday.post("https://billing.example.internal/v1/refunds", { id: refund_id }.to_json)
end
