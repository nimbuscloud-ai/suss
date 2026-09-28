require "test_helper"

class CheckoutTest < ActiveSupport::TestCase
  test "cancels on a failed checkout" do
    Order.stub(:cancel, { status: :cancelled }) do
      Checkout.fail("o-1")
    end
  end
end
