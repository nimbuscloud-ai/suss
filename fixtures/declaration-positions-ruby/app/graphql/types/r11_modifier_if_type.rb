# The one-line spelling of r02. It parses as an `if_modifier` wrapping the
# call, so the call is not a statement of the body either.
class Types::R11ModifierIfType < Types::BaseObject
  field :value, String, null: false if ENV["FEATURE_VALUE"] == "on"
end
