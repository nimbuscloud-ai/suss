require "pg"

module Billing
  module InvoiceStore
    def self.save(invoice_id)
      conn = PG.connect(ENV["DATABASE_URL"])
      conn.exec_params(
        "INSERT INTO invoices (id, status) VALUES ($1, 'charged')",
        [invoice_id]
      )
    end
  end
end
