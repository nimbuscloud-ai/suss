class Types::OrganizerType < Types::BaseObject
  include Concerns::Contactable

  field :id, ID, null: false
  field :email, String, null: false

  field :display_name, String, null: false

  def display_name
    [object.first_name, object.last_name].compact.join(" ")
  end

  field :phone, String, null: true

  # A computed type expression, not a literal type constant.
  field :status, status_label_for(:organizer), null: true
end
