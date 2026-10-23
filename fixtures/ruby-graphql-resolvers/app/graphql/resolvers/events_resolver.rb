module Resolvers
  class EventsResolver < BaseResolver
    type [Types::EventType], null: false

    argument :include_archived, Boolean, required: false

    def resolve(include_archived: false)
      include_archived ? Event.all : Event.where(archived_at: nil)
    end
  end
end
