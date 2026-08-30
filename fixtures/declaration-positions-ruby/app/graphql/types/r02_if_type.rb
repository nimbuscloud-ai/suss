# A field behind an environment check, which is ordinary in a Rails app.
class Types::R02IfType < Types::BaseObject
  if ENV["FEATURE_VALUE"] == "on"
    field :value, String, null: false
  end
end
