module Resolvers
  class ReviewsResolver < BaseResolver
    type [Types::ReviewType], null: false

    def resolve
      Review.where(talk_id: object.id)
    end
  end
end
