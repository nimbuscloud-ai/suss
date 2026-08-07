class Types::OrganizerType < Types::BaseObject
  field :id, ID, null: false
  field :email, String, null: false

  # Computed at the class level rather than named as a literal type
  # constant, so the reader has nothing to read here and abstains: no
  # declared contract for this field, though the field itself is still
  # discovered by name.
  field :status, status_label_for(:organizer), null: true
end
