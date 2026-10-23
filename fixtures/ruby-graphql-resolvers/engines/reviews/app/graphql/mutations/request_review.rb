module Mutations
  class RequestReview < BaseMutation
    argument :talk_id, ID, required: true

    field :review, Types::ReviewType, null: false

    def ready?(**args)
      raise GraphQL::ExecutionError, "Reviews are closed" if ReviewWindow.closed?

      super
    end

    def resolve(talk_id:)
      { review: Review.create!(talk_id: talk_id) }
    end
  end
end
