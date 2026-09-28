require "rails_helper"

RSpec.describe Order do
  describe "cancel" do
    let(:id) { "o-1" }

    it "marks the order cancelled" do
      expect(Order.cancel(id)[:status]).to eq(:cancelled)
    end

    it "refunds the payment" do
      expect(Order.refund(id)).to be(true)
    end

    xit "cancels twice without harm" do
      Order.cancel(id)
      Order.cancel(id)
    end
  end
end
