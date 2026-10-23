module Invoices
  class CreateService < BaseService
    def self.perform(**args)
      AuditEntry.create!(action: "invoice.create")
    end

    def call
      Invoice.create!(amount: @args[:amount])
    end
  end
end
