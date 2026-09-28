require "rails_helper"

RSpec.describe Order do
  it "is never read" do
    Order.refund("o-1")
  end
end
