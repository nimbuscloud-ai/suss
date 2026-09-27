# What other modules may call. The invoice store stays private.

require "pg"
require_relative "billing/invoice_store"

module Billing
  def self.charge_invoice(invoice_id)
    conn = PG.connect(ENV["DATABASE_URL"])
    conn.exec_params(
      "UPDATE accounts SET balance = balance - 1 WHERE invoice_id = $1",
      [invoice_id]
    )
    InvoiceStore.save(invoice_id)
    "charged"
  end
end
