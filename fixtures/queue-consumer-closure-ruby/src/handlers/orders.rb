# Runs in OrdersWorker, which drains OrdersQueue. Both calls it makes
# happen again when the queue delivers a message twice: the one here
# and the one inside the billing helper it imports.

require "json"
require_relative "../lib/billing"

def post_receipt(order_id)
  Faraday.post("https://orders.example.internal/v1/receipts", { order_id: order_id }.to_json)
end

def handler(event:, context:)
  event["Records"].each do |record|
    order = JSON.parse(record["body"])
    post_receipt(order["id"])
    charge_account(order["account"])
  end
end
