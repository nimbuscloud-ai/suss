class Mutations::ApproveTalk < Mutations::BaseMutation
  argument :id, ID, required: true

  field :talk, Types::TalkType
  field :errors, [String], null: false

  def authorized?(id:)
    talk = Talk.find(id)
    unless talk.event.organizer_id == context[:current_user].id
      return false, { talk: nil, errors: ["Only the organizer can approve"] }
    end

    super
  end

  def resolve(id:)
    talk = Talk.find(id)
    talk.update!(approved_at: Time.current)
    { talk: talk, errors: [] }
  end
end
