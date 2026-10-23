module Types
  class ReviewType < Types::BaseObject
    field :id, ID, null: false
    field :body, String, null: true
  end
end
