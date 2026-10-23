module Types
  class MutationType < Types::BaseObject
    field :approve_talk, mutation: Mutations::ApproveTalk
    field :archive_event, mutation: Mutations::ArchiveEvent
    field :request_review, mutation: Mutations::RequestReview
  end
end
