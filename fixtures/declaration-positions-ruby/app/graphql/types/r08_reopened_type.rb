# One class opened twice. Ruby runs both bodies against the same class,
# so the second block's fields belong to the same type as the first's.
class Types::R08ReopenedType < Types::BaseObject
end

class Types::R08ReopenedType
  field :value, String, null: false
end
