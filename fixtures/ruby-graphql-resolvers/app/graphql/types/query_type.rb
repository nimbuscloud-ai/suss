module Types
  class QueryType < Types::BaseObject
    field :events, resolver: Resolvers::EventsResolver
    field :event_count, Integer, null: false, resolver_method: :count_events

    def count_events
      Event.where(archived_at: nil).count
    end
  end
end
