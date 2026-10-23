module Mutations
  class ArchiveEvent < GraphQL::Schema::RelayClassicMutation
    argument :event_id, ID, required: true
    argument :reason, String, required: false

    field :event, Types::EventType, null: true

    def ready?(**args)
      return false, { event: nil } if Event.where(id: args[:event_id]).none?

      true
    end

    def resolve(event_id:, reason: nil)
      event = Event.find(event_id)
      event.update!(archived_at: Time.current, archive_reason: reason)
      { event: event }
    end
  end
end
