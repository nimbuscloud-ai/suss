class Types::OrganizerType < Types::BaseObject
  # id and email are answered by reading the attribute off the object
  # the field is resolved against. There is no method behind either.
  field :id, ID, null: false
  field :email, String, null: false

  # display_name is answered by the method of the same name below it,
  # the common shape in a graphql-ruby schema.
  field :display_name, String, null: false

  def display_name
    [object.first_name, object.last_name].compact.join(" ")
  end

  # Computed at the class level rather than named as a literal type
  # constant, so the reader has nothing to read here and abstains: no
  # declared contract for this field, though the field itself is still
  # discovered by name.
  field :status, status_label_for(:organizer), null: true
end
