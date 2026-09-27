class Types::OrderType < Types::BaseObject
  field :id, ID, null: false
  field :reference, String, null: true
  field :status, String, null: true
end
