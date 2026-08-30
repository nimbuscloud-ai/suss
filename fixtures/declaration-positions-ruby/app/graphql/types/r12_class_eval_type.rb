# `class_eval` with no receiver runs its block against this class, so the
# field it declares is this type's field.
class Types::R12ClassEvalType < Types::BaseObject
  class_eval do
    field :value, String, null: false
  end
end
