class Types::R03UnlessType < Types::BaseObject
  unless ENV["HIDE_VALUE"] == "on"
    field :value, String, null: false
  end
end
