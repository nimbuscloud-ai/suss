class Checkout
  def self.fail(id)
    Order.cancel(id)
  end
end
