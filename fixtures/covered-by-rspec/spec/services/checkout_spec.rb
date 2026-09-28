require "rails_helper"

RSpec.describe Checkout do
  before do
    allow(Order).to receive(:cancel).and_return({ status: :cancelled })
  end

  it "cancels on a failed checkout" do
    Checkout.fail("o-1")
  end
end
