module Types
  class TalkType < Types::BaseObject
    field :id, ID, null: false
    field :approved_at, GraphQL::Types::ISO8601DateTime, null: true
    field :reviews, resolver: Resolvers::ReviewsResolver
  end
end
