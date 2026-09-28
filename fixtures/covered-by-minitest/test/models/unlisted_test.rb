require "test_helper"

class UnlistedTest < ActiveSupport::TestCase
  test "is never read" do
    Order.refund("o-1")
  end
end
