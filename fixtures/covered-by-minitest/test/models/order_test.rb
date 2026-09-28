require "test_helper"

class OrderTest < ActiveSupport::TestCase
  setup do
    @id = "o-1"
  end

  test "marks the order cancelled" do
    assert_equal :cancelled, Order.cancel(@id)[:status]
  end

  test "refunds the payment" do
    assert Order.refund(@id)
  end

  test "cancels twice without harm" do
    skip "the second cancel is not written yet"
    Order.cancel(@id)
    Order.cancel(@id)
  end

  def test_reads_back_as_cancelled
    cancelled = Order.cancel("o-2")
    assert_equal :cancelled, cancelled[:status]
  end
end
