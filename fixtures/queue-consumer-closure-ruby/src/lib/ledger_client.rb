# Required by both handlers. Only the orders handler builds it with no
# argument, so only OrdersWorker runs the default and reads ORDERS_LEDGER.
# The accounts handler passes a ledger, and its function declares none.

class LedgerClient
  def initialize(ledger = ENV["ORDERS_LEDGER"])
    @ledger = ledger
  end

  def ledger
    @ledger
  end
end
