class Types::QueryType < Types::BaseObject
  field :order, Types::OrderType, null: true do
    argument :id, ID, required: true
  end

  def order(id:)
    Order.find(id)
  end
end
