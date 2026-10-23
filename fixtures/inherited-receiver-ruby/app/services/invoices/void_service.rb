module Invoices
  class VoidService < BaseService
    def call
      Invoice.where(id: @args[:id]).update_all(status: "voided")
    end
  end
end
